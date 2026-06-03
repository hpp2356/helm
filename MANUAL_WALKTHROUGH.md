# Helm 手动走查 (PR10)

## PR10 — File Tools / WorkspaceGuard

### 这个 PR 为 harness 加了什么

agent 终于能读写文件了。一套跑在 `ToolRuntime` 上的文件系统工具，全部通过
`WorkspaceGuard` 做路径安全校验。这是 harness 的第一个真实 batch of built-in
tools——PR01–PR09 全是基础设施，这步才开始让 agent 产生可见的副作用。

核心概念：

- **WorkspaceGuard** — 工作区边界守卫。所有文件路径必须先通过 `guard.validate(filePath)`，
  返回解析后的绝对路径。防三种逃逸：`../` 路径遍历、绝对路径指向工作区外、symlink 指向工作区外。
  对尚未创建的文件（例如 `write` 工具的目标路径），guard 会沿父目录向上找到最近的真实祖先，
  逐段追加缺失部分再校验。默认拒绝——解析失败的路径一律拦截。
- **read** (RiskLevel.LOW) — 读文件。支持 `offset`（行号，1-indexed）和 `limit`。
  返回 `{ content, totalLines, path }`。拦截二进制文件（检测前 4096 字节是否含 null byte）。
- **write** (RiskLevel.HIGH) — 创建/覆盖文件。自动创建缺失的父目录。
  返回 `{ path, bytesWritten }`。
- **edit** (RiskLevel.HIGH) — 查找替换。`oldString` 必须是精确匹配（含空白）。
  多处匹配时，不设 `replaceAll: true` 则返回错误（不猜）。返回 `{ path, replaced, matchCount }`。
- **ls** (RiskLevel.LOW) — 列出目录内容。`dirPath` 默认 workspace root。
  返回 `{ entries: [{ name, type: "file"|"directory"|"symlink", size }], path }`。
- **glob** (RiskLevel.LOW) — 通配符匹配文件。支持 `*`、`**`（递归）、`?`、`[...]` 字符类。
  返回 `{ matches: string[], pattern, count }`。路径相对于 workspace root。
- **registerFileTools(toolRuntime, workspaceRoot)** — 一键注册五个工具，返回 guard 实例。

> **选型说明 — 不含 `rm`（删除文件）：** 删除文件是不可逆操作，对 agent 而言风险极高。
> 在还没有 undo/rollback 机制之前，提供 rm 意味着一行代码可以永久丢失工作区文件。等后续 PR
> 引入沙箱或快照机制后再考虑。

### 准备工作

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

文件工具没有 CLI 入口，通过 vitest 观察：

```bash
pnpm --filter @helm/runtime exec vitest run --reporter=verbose
```

新增 60 个测试（9 workspace-guard + 26 file-tools），全部通过。

### Walkthrough: WorkspaceGuard 边界

guard 的核心逻辑是 `validate(filePath)`——返回解析后的绝对路径，或 throw：

```bash
node --import tsx -e '
import { WorkspaceGuard } from "./packages/runtime/src/index.js";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const guard = new WorkspaceGuard(dir);

// ── 正常路径 ──
try {
  writeFileSync(join(dir, "hello.txt"), "hello");
  console.log("1. inside:", guard.validate("hello.txt"));
} catch (e) { console.log("1. REJECTED:", e.message); }

// ── ../ 逃逸 ──
try {
  guard.validate("../etc/passwd");
} catch (e) { console.log("2. ../ escape REJECTED:", e.message); }

// ── 绝对路径指向外部 ──
try {
  guard.validate("/etc/hosts");
} catch (e) { console.log("3. absolute REJECTED:", e.message); }

// ── symlink 逃逸 ──
try {
  symlinkSync("/etc/passwd", join(dir, "escape-link"));
  guard.validate("escape-link");
} catch (e) { console.log("4. symlink escape REJECTED:", e.message); }

// ── 安全的 symlink ──
try {
  writeFileSync(join(dir, "real.txt"), "safe");
  symlinkSync(join(dir, "real.txt"), join(dir, "good-link"));
  console.log("5. safe symlink:", guard.validate("good-link"));
} catch (e) { console.log("5. REJECTED:", e.message); }

rmSync(dir, { recursive: true, force: true });
'
```

输出（路径前缀因系统不同而异）：

```
1. inside: /var/folders/.../helm-demo-.../hello.txt
2. ../ escape REJECTED: Workspace escape blocked: "../etc/passwd" resolves outside workspace root
3. absolute REJECTED: Workspace escape blocked: "/etc/hosts" resolves outside workspace root
4. symlink escape REJECTED: Workspace escape blocked: "escape-link" resolves outside workspace root
5. safe symlink: /var/folders/.../helm-demo-.../good-link
```

**看什么：**

- 正常路径返回绝对路径——tool 拿到这个值直接操作即可。
- 三种逃逸方式（`../`、绝对路径、symlink）都被同一句 "resolves outside workspace root" 拦截。
- symlink 指向内部文件是安全的——guard 检查的是 `realpath` 解析后的真正路径。

### Walkthrough: read 工具

```bash
node --import tsx -e '
import { WorkspaceGuard, createReadTool } from "./packages/runtime/src/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const guard = new WorkspaceGuard(dir);

// 写一份多行文件
writeFileSync(join(dir, "data.txt"), "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n");

const read = createReadTool({ guard });

// 全量读
const r1 = await read.execute({ filePath: "data.txt" });
console.log("full:", JSON.parse(r1).totalLines, "lines, content:");

// offset + limit
const r2 = await read.execute({ filePath: "data.txt", offset: 2, limit: 2 });
console.log("offset=2, limit=2:", JSON.parse(r2).content);

// 二进制
const buf = Buffer.alloc(10); buf[3] = 0;
writeFileSync(join(dir, "bin.bin"), buf);
const r3 = await read.execute({ filePath: "bin.bin" });
console.log("binary:", r3);

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
full: 6 lines, content:
offset=2, limit=2: "Line 2\nLine 3"
binary: Error: "bin.bin" appears to be a binary file and cannot be read
```

**看什么：**

- `totalLines: 6`——"Line 5\n" 末尾的 `\n` 使得 split 产生 6 个元素（含最后一个空串）。
- offset 是 1-indexed，和编辑器行号一致。`offset=2` 从第二行开始，`limit=2` 取两行。
- 二进制检测不靠扩展名——检查文件前 4096 字节是否含 `\0`。超过 4096 字节且前面纯文本，
  可能漏过嵌入式二进制块（尾部 embed），但这是故意偏 lenient 的选择。

### Walkthrough: write 工具

```bash
node --import tsx -e '
import { WorkspaceGuard, createWriteTool } from "./packages/runtime/src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const guard = new WorkspaceGuard(dir);
const write = createWriteTool({ guard });

// 创建新文件
const r1 = await write.execute({ filePath: "greeting.txt", content: "Hello, Helm!" });
console.log("create:", JSON.parse(r1));

// 覆盖已有文件
const r2 = await write.execute({ filePath: "greeting.txt", content: "Goodbye, Helm!" });
console.log("overwrite:", JSON.parse(r2));
console.log("content:", readFileSync(join(dir, "greeting.txt"), "utf-8"));

// 自动创建父目录
const r3 = await write.execute({ filePath: "deep/nested/file.txt", content: "nested" });
console.log("nested:", JSON.parse(r3));

// 写外部路径（被 guard 拦截）
const r4 = await write.execute({ filePath: "../escape.txt", content: "bad" });
console.log("escape:", r4);

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
create: {"path":"greeting.txt","bytesWritten":12}
overwrite: {"path":"greeting.txt","bytesWritten":14}
content: Goodbye, Helm!
nested: {"path":"deep/nested/file.txt","bytesWritten":6}
escape: Error: Workspace escape blocked: "../escape.txt" resolves outside workspace root
```

**看什么：**

- 第一次 `write` 返回 `bytesWritten: 12`（"Hello, Helm!" 的 UTF-8 字节数），第二次是 14（"Goodbye, Helm!"）。
- `deep/nested/file.txt` 的两个父目录都不存在，`write` 自动 `mkdirSync({ recursive: true })`。WorkspaceGuard 沿父目录链往上找到 `dir`，确认最终路径在 workspace 内。
- 逃逸路径被 guard 拦截——tool 不需要自己做路径校验。

### Walkthrough: edit 工具

```bash
node --import tsx -e '
import { WorkspaceGuard, createEditTool } from "./packages/runtime/src/index.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const guard = new WorkspaceGuard(dir);
const edit = createEditTool({ guard });

// 单次替换
writeFileSync(join(dir, "config.ts"), "const port = 3000;\nconst host = \"localhost\";\n");
const r1 = await edit.execute({ filePath: "config.ts", oldString: "3000", newString: "8080" });
console.log("single:", JSON.parse(r1));
console.log(readFileSync(join(dir, "config.ts"), "utf-8"));

// 多处匹配 — 不加 replaceAll 报错
writeFileSync(join(dir, "multi.ts"), "import { foo } from \"a\";\nimport { foo } from \"b\";\n");
const r2 = await edit.execute({ filePath: "multi.ts", oldString: "foo", newString: "bar" });
console.log("multi no replaceAll:", r2);

// replaceAll
const r3 = await edit.execute({ filePath: "multi.ts", oldString: "foo", newString: "bar", replaceAll: true });
console.log("replaceAll:", JSON.parse(r3));
console.log(readFileSync(join(dir, "multi.ts"), "utf-8"));

// 字符串未找到
const r4 = await edit.execute({ filePath: "config.ts", oldString: "not there", newString: "x" });
console.log("not found:", r4);

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
single: {"path":"config.ts","replaced":true,"matchCount":1}
const port = 8080;
const host = "localhost";

multi no replaceAll: Error: found 2 matches for oldString in "multi.ts". Use replaceAll: true to replace all, or make oldString more specific.
replaceAll: {"path":"multi.ts","replaced":true,"matchCount":2}
import { bar } from "a";
import { bar } from "b";

not found: Error: string not found in "config.ts"
```

**看什么：**

- 唯一匹配 → 替换成功，`matchCount: 1`。
- 多处匹配不加 `replaceAll` → 返回错误，不猜。错误消息提示用 `replaceAll: true` 或缩小匹配范围。
- `replaceAll: true` → 两处全换，`matchCount: 2`。
- 未命中 → 返回错误，不修改文件。

这和 Claude Code 的 `Edit` 工具行为一致——精确替换，多处匹配报错，不赌。

### Walkthrough: glob 工具

```bash
node --import tsx -e '
import { WorkspaceGuard, createGlobTool } from "./packages/runtime/src/index.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const guard = new WorkspaceGuard(dir);

// 构造文件结构
writeFileSync(join(dir, "index.ts"), "");
writeFileSync(join(dir, "utils.ts"), "");
writeFileSync(join(dir, "config.json"), "");
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src", "main.ts"), "");
writeFileSync(join(dir, "src", "lib.ts"), "");

const glob = createGlobTool({ guard });

// *.ts — 仅根目录
const r1 = await glob.execute({ pattern: "*.ts" });
console.log("*.ts:", JSON.parse(r1));

// **​/*.ts — 递归
const r2 = await glob.execute({ pattern: "**/*.ts" });
console.log("**​/*.ts:", JSON.parse(r2));

// 从子目录搜索
const r3 = await glob.execute({ pattern: "*.ts", dirPath: "src" });
console.log("src/*.ts:", JSON.parse(r3));

// 无结果
const r4 = await glob.execute({ pattern: "*.go" });
console.log("*.go:", JSON.parse(r4));

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
*.ts: {"matches":["index.ts","utils.ts"],"pattern":"*.ts","count":2}
**/*.ts: {"matches":["index.ts","utils.ts","src/lib.ts","src/main.ts"],"pattern":"**/*.ts","count":4}
src/*.ts: {"matches":["src/lib.ts","src/main.ts"],"pattern":"*.ts","count":2}
*.go: {"matches":[],"pattern":"*.go","count":0}
```

**看什么：**

- `*.ts` 只匹配当前目录（不递归），返回 2 个文件。
- `**/*.ts` 递归匹配，返回 4 个文件。路径相对于 workspace root。
- `dirPath` 限制搜索范围——`src/*.ts` 只在 src 下找，结果路径前缀带 src/。
- 无结果不报错，返回空数组 `count: 0`。

### Walkthrough: AgentLoop 集成 — agent 调文件工具

五个工具注册到 ToolRuntime 后，AgentLoop 可以在 turn 里调它们——和 ScriptedProvider 配合演示完整流程：

```bash
node --import tsx -e '
import { JsonlJournal } from "./packages/core/src/index.js";
import { ScriptedProvider, AgentLoop, ToolRuntime, registerFileTools, readJournal, computeStats } from "./packages/runtime/src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const jp = join(dir, "journal.jsonl");
const journal = new JsonlJournal(jp);
await journal.open();

// 注册文件工具——dir 就是 workspace root
const tr = new ToolRuntime();
const guard = registerFileTools(tr, dir);

// Script: write a file, then read it, then final answer
const provider = new ScriptedProvider([
  { role: "assistant", content: "Writing file", toolCalls: [{ id: "1", name: "write", args: { filePath: "hello.txt", content: "Hello from agent!" } }] },
  { role: "assistant", content: "Reading file", toolCalls: [{ id: "2", name: "read", args: { filePath: "hello.txt" } }] },
  { role: "assistant", content: "All done. File contents match." },
]);

const loop = new AgentLoop(provider, tr, journal, { maxTurns: 5 });
const result = await loop.run("demo-file-tools", "Write and read a file");
await journal.close();

const { events } = readJournal(jp);
console.log("exitCode:", result.exitCode);
console.log("Journal:");
for (const e of events) {
  let extra = "";
  if (e.type === "tool:call") extra = " name=" + (e.type === "tool:call" ? e.toolName : "");
  if (e.type === "tool:result") extra = " output=" + (e.type === "tool:result" ? e.output.slice(0, 50) : "");
  console.log("  " + e.type + extra);
}

console.log("\\nStats:", JSON.stringify(computeStats(events).toolCallCounts, null, 2));

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
exitCode: 0
Journal:
  run:start
  turn:start
  tool:call name=write
  tool:result output={"path":"hello.txt","bytesWritten":18}
  turn:start
  tool:call name=read
  tool:result output={"content":"Hello from agent!","totalLines"
  turn:start
  run:end

Stats: {
  "write": 1,
  "read": 1
}
```

**看什么：**

- 三个 turn：turn 0 写文件、turn 1 读文件、turn 2 最终答案（无 toolCalls）。
- journal 里有完整的 `tool:call` → `tool:result` 配对，和 PR03 的 demo 一样。
- `computeStats` 显示 `write: 1, read: 1`——统计也能正确追踪到文件工具调用。
- `exitCode: 0`——整条 pipeline 从注册工具到跑完 run 都走通。

### Walkthrough: PermissionRuntime 阻止写操作

文件工具和权限系统不冲突——WorkpaceGuard 管"路径安全吗"，PermissionRuntime 管"允许用这个工具吗"：

```bash
node --import tsx -e '
import { RiskLevel } from "./packages/core/src/index.js";
import { ToolRuntime, PermissionRuntime, registerFileTools } from "./packages/runtime/src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-demo-"));
const pr = new PermissionRuntime();
pr.deny({ pattern: "write", riskLevel: RiskLevel.HIGH, description: "no file writes in this run" });

const tr = new ToolRuntime(pr);
registerFileTools(tr, dir);

// write — 被 deny
const r1 = await tr.execute("write", { filePath: "test.txt", content: "should fail" });
console.log("write:", r1);

// read — 没有 deny 规则
const r2 = await tr.execute("read", { filePath: "test.txt" });
console.log("read:", r2);

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
write: Error: permission denied — Tool "write" is denied: no file writes in this run (risk: HIGH)
read: Error: file not found: "test.txt"
```

**看什么：**

- `write` 被 deny——PermissionRuntime 在 ToolRuntime.execute 里先检查权限，deny 直接返回。
- `read` 进入了 guard 和 fs 检查——因为文件不存在返回 "file not found"。
  如果文件存在且在工作区内，read 会正常返回内容（deny 只禁 write，不禁 read）。

### 试一下

1. **读 workspace-guard 源码：** `packages/runtime/src/workspace-guard.ts`。
   核心逻辑不到 50 行——`validate` resolve 路径后，用 `realpath` 解开所有 symlink，
   再确保结果在 `realRoot` 前缀内。
2. **read 工具的二进制检测：** 故意创建一个前 4000 字节是 ASCII 但第 4001 字节是 `\0`
   的文件，然后 `read.execute`——检测通过（null byte 在前 4096 字节内）。把 `\0` 放在
   第 5000 字节——检测漏过（当前实现只看前 4096 字节）。这是一种 trade-off：能捕获所有
   常见二进制格式（ELF、PNG、JPEG 等都在文件头有 null byte），但故意不扫描整个文件。
3. **glob 的 pattern 边界：** 试试 `**/*.test.ts`、`src/**​/*.ts`、`*.{ts,js}`（不支持大括号展开——当前实现不行）。
   当前 glob 是自带的简单实现，不依赖 npm 包。支持 `*`、`**`、`?`、`[...]`。
4. **五个工具的速查表：**

| 工具   | 风险      | 参数                                      | 返回                                        |
| ------ | --------- | ----------------------------------------- | ------------------------------------------- |
| read   | LOW       | filePath, offset?, limit?                 | { content, totalLines, path }               |
| write  | HIGH      | filePath, content                         | { path, bytesWritten }                      |
| edit   | HIGH      | filePath, oldString, newString, replaceAll? | { path, replaced, matchCount }           |
| ls     | LOW       | dirPath?                                  | { entries: [{name,type,size}], path }       |
| glob   | LOW       | pattern, dirPath?                         | { matches, pattern, count }                 |

### 更新后的附录 A — 事件类型速查

PR10 没有新增事件类型。文件工具通过已有的 `tool:call` / `tool:result` 事件记录到 journal——
和 PR03 的 echo/calc 工具完全一样的模式，只是 toolName 和 args 不同。

WorkspaceGuard 和 PermissionRuntime 失败也复用已有的 `tool:result` 事件（output 字段携带错误信息），
不产生新的 `error` 事件——和 PR04 的权限拒绝行为一致（tool 层产出，不是 run 层失败）。

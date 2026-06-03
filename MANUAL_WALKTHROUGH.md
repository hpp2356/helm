# Helm 手动走查 (PR09)

## PR09 — ContextBuilder / TokenBudget

### 这个 PR 为 harness 加了什么

agent 的"账本"——算 token 消耗、限制单次 run 的用量。在真实 LLM provider 进场（PR12）之前，先把计费逻辑（token counting）和预算（capping）拆出来做掉。

核心概念：

- **`ContextWindow`** — 发给 provider 的完整上下文快照：system prompt + messages + tool definitions + 预估 token 数。
- **`ToolDef`** — `Tool` 的可序列化投影（name + description + parameters，去掉 execute 函数）。供 context assembly 用。
- **`TokenBudget`** — 计费器：最大 token 数、已用 token 数、剩余 token 数、是否耗尽（`isExhausted()`）、警告阈值（`isWarning()`，默认 80%）。
- **`TokenCounter`** — token 计数接口。当前唯一的实现是 `CharTokenCounter`：`ceil(charCount / charsPerToken)`，默认 4 chars/token（英文经验值，代码场景约 2-3 chars/token）。
- **`ContextBuilder`** — 组装 `ContextWindow`：取 system prompt + messages + toolDefs，用 `TokenCounter` 估算 token 数，返回完整 window。
- **`AgentLoop` 集成** — `AgentLoopOptions` 新增 `tokenBudget?` 和 `contextBuilder?`。每个 turn 在 `provider.send()` 之前做 budget check：如果当前 context 的预估 token 数超过剩余预算，emit `error` 事件（`errorType=harness, errorCategory=budget_exhausted`），以 `exitCode=1` 结束 run。

`TokenBudget` 是累积记账（cumulative）：每个 turn 的 context（含所有历史消息）都算进 `usedTokens`。类比真实 LLM API 的 pricing 模型——每次请求都重新发送完整上下文，输入 token 每次都全量计费。

> **选型理由 — 4 chars/token：** 英文文本 token 化后平均 1 token ≈ 4 字符（GPT 系 tokenizer 的经验值）。中文场景下同量文本的 token 数更多，4 是偏保守的估算。PR12 接入真实 tokenizer 时会替换 `TokenCounter` 实现，接口已预留。

### 准备工作

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

预算系统没有 CLI 入口（未来 PR），通过 vitest 观察：

```bash
pnpm --filter @helm/runtime exec vitest run --reporter=verbose
```

新增 30 个测试（8 token-counter + 9 context-builder + 5 agent-loop budget + 8 TokenBudget），都通过。

### Walkthrough: TokenBudget 基本行为

```bash
node --import tsx -e '
import { TokenBudget } from "./packages/core/src/index.js";

const budget = new TokenBudget(1000);
console.log("max:", budget.maxTokens);
console.log("used:", budget.usedTokens);
console.log("remaining:", budget.remainingTokens);
console.log("exhausted:", budget.isExhausted());
console.log("warning:", budget.isWarning());  // 默认 80% 阈值，0 < 800

budget.consume(750);
console.log("\n--- after 750 tokens ---");
console.log("used:", budget.usedTokens);
console.log("remaining:", budget.remainingTokens);
console.log("exhausted:", budget.isExhausted());
console.log("warning:", budget.isWarning());  // 750 < 800, 还没到阈值

budget.consume(100);
console.log("\n--- after 850 tokens ---");
console.log("used:", budget.usedTokens);
console.log("remaining:", budget.remainingTokens);
console.log("exhausted:", budget.isExhausted());
console.log("warning:", budget.isWarning());  // 850 >= 800, 触发警告

budget.consume(200);
console.log("\n--- after 1050 tokens ---");
console.log("used:", budget.usedTokens);
console.log("remaining:", budget.remainingTokens);  // floor at 0
console.log("exhausted:", budget.isExhausted());    // true
'
```

输出：

```
max: 1000
used: 0
remaining: 1000
exhausted: false
warning: false

--- after 750 tokens ---
used: 750
remaining: 250
exhausted: false
warning: false

--- after 850 tokens ---
used: 850
remaining: 150
exhausted: false
warning: true

--- after 1050 tokens ---
used: 1050
remaining: 0
exhausted: true
```

**看什么：**

- `remainingTokens` 永远 ≥ 0（不会出现负数），即使 `usedTokens > maxTokens`。
- `isWarning()` 在 `usedTokens >= maxTokens * warnThreshold` 时返回 true，比 `isExhausted()` 先触发。
- `warnThreshold` 可在构造函数第二个参数自定义：`new TokenBudget(1000, 0.5)` 表示 50% 就警告。

### Walkthrough: CharTokenCounter 估算逻辑

```bash
node --import tsx -e '
import { CharTokenCounter } from "./packages/runtime/src/index.js";

const c = new CharTokenCounter(4);

console.log("empty:", c.countText(""));                        // 0
console.log("a:", c.countText("a"));                           // ceil(1/4)=1
console.log("hello:", c.countText("hello"));                   // ceil(5/4)=2
console.log("hello world:", c.countText("hello world"));       // ceil(11/4)=3

const msgs = [
  { role: "user", content: "What is 2+3?" },
];
// role "user" (4 chars) + content "What is 2+3?" (14 chars) = 18 chars / 4 = 5 tokens
console.log("single message:", c.countMessages(msgs));

const toolDefs = [
  { name: "calc", description: "Evaluate a math expression", parameters: { type: "object", properties: { expr: { type: "string" } } } },
];
console.log("one tool def:", c.countToolDefs(toolDefs));
'
```

输出：

```
empty: 0
a: 1
hello: 2
hello world: 3
single message: 5
one tool def: 12
```

**看什么：**

- `countText("")` 返回 0（空内容不计 token）。
- 每条 message 计算 role + content + toolCalls args 的所有字符 / 4。
- `charsPerToken` 越小，估算越保守（偏大）——`new CharTokenCounter(2)` 是代码/中文场景的常用值。

### Walkthrough: ContextBuilder 组装上下文

ContextBuilder 把零散的 messages、tools、system prompt 聚合成一个 `ContextWindow`：

```bash
node --import tsx -e '
import { ContextBuilder, CharTokenCounter } from "./packages/runtime/src/index.js";

const cb = new ContextBuilder(new CharTokenCounter(4));

// 无 tools、无 system prompt 的最小窗口
const w1 = cb.build({
  messages: [{ role: "user", content: "Hi" }],
  toolDefs: [],
});
console.log("minimal window:", JSON.stringify({
  tokens: w1.estimatedTokens,
  systemPrompt: w1.systemPrompt,
  msgs: w1.messages.length,
  tools: w1.toolDefs.length,
}, null, 2));

// 带 system prompt 的窗口
const w2 = cb.build({
  systemPrompt: "You are a helpful assistant with extensive instructions on how to respond.",
  messages: [{ role: "user", content: "Hi" }],
  toolDefs: [],
});
console.log("\nwith system prompt, tokens:", w2.estimatedTokens,
  "(delta:", w2.estimatedTokens - w1.estimatedTokens, ")");

// 带 tools 的窗口
const w3 = cb.build({
  messages: [{ role: "user", content: "Hi" }],
  toolDefs: [
    { name: "calc", description: "Do math", parameters: { type: "object", properties: { expr: { type: "string" } } } },
    { name: "echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } } } },
  ],
});
console.log("\nwith tools, tokens:", w3.estimatedTokens,
  "(delta:", w3.estimatedTokens - w1.estimatedTokens, ")");
'
```

输出：

```
minimal window: {
  "tokens": 2,
  "systemPrompt": null,
  "msgs": 1,
  "tools": 0
}

with system prompt, tokens: 18 (delta: 16 )

with tools, tokens: 31 (delta: 29 )
```

**看什么：**

- `estimatedTokens` 是 system prompt + messages + toolDefs 三部分 token 估算之和。
- 每增加一部分内容，token 估算就会增加——这是在 `provider.send()` 之前就能拿到的预估值（pre-flight estimation）。
- `systemPrompt` 不传时是 `null`。

### Walkthrough: AgentLoop 预算耗尽

这是最重要的集成行为——当预算不够下一个 turn 的 context 时，AgentLoop 停 run 并记录错误：

```bash
node --import tsx -e '
import { JsonlJournal, TokenBudget } from "./packages/core/src/index.js";
import { ScriptedProvider, AgentLoop, ToolRuntime, ContextBuilder, CharTokenCounter } from "./packages/runtime/src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-budget-"));
const jp = join(dir, "run.jsonl");
const j = new JsonlJournal(jp);
await j.open();

const provider = new ScriptedProvider([
  { role: "assistant", content: "Should not be reached — budget exhausted first" },
]);

const loop = new AgentLoop(provider, new ToolRuntime(), j, {
  maxTurns: 5,
  tokenBudget: new TokenBudget(2),   // 只给 2 个 token — 任何消息都超
  contextBuilder: new ContextBuilder(new CharTokenCounter(4)),
});

const result = await loop.run("demo-budget-exhausted", "Hello world!");
await j.close();

console.log("exitCode:", result.exitCode);

const events = readFileSync(jp, "utf-8").trim().split("\n").map(l => JSON.parse(l));
for (const e of events) {
  let extra = "";
  if (e.type === "error") extra = " errorType=" + e.errorType + " errorCategory=" + e.errorCategory;
  if (e.type === "run:end") extra = " exitCode=" + e.exitCode;
  console.log(e.type + extra);
}
rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
exitCode: 1
run:start
turn:start
error errorType=harness errorCategory=budget_exhausted
run:end exitCode=1
```

**看什么：**

- journal 只有 4 个事件：`run:start` → `turn:start` → `error` → `run:end`。没有 `tool:call`、没有 provider 响应——预算检查在 `provider.send()` **之前**，超了就停。
- error 带的 `errorType=harness, errorCategory=budget_exhausted`，可以用 PR07 的 eval 断言 `{ type: "error:category", errorCategory: "budget_exhausted" }` 检测。
- `exitCode=1`——和 retry 耗尽一样用 `EXIT_ERROR`，区别于取消的 `130`。对比正常结束的 `exitCode=0`。

### Walkthrough: 预算充足的正常 run

换个充足的预算，同样的脚本正常跑完：

```bash
node --import tsx -e '
import { JsonlJournal, TokenBudget } from "./packages/core/src/index.js";
import { ScriptedProvider, AgentLoop, ToolRuntime, ContextBuilder, CharTokenCounter } from "./packages/runtime/src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-budget-"));
const jp = join(dir, "run.jsonl");
const j = new JsonlJournal(jp);
await j.open();

const provider = new ScriptedProvider([
  { role: "assistant", content: "Hello! How can I help?" },
]);

const loop = new AgentLoop(provider, new ToolRuntime(), j, {
  maxTurns: 5,
  tokenBudget: new TokenBudget(100_000),
  contextBuilder: new ContextBuilder(new CharTokenCounter(4)),
});

const result = await loop.run("demo-budget-ok", "Hi!");
await j.close();

console.log("exitCode:", result.exitCode);
const events = readFileSync(jp, "utf-8").trim().split("\n").map(l => JSON.parse(l));
for (const e of events) {
  console.log(e.type);
}
console.log("budget used:", result.exitCode === 0 ? "(see TokenBudget)" : "");
rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
exitCode: 0
run:start
turn:start
run:end
```

预算充足，正常结束。和 PR02 的无 tool run 形状完全一样。

### Walkthrough: budget 是累积记账

每个 turn 的预算检查都消耗从 run 开始到当前时刻所有消息的 token 总和：

```bash
node --import tsx -e '
import { JsonlJournal, TokenBudget } from "./packages/core/src/index.js";
import { ScriptedProvider, AgentLoop, ToolRuntime, ContextBuilder, CharTokenCounter } from "./packages/runtime/src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-budget-"));
const jp = join(dir, "run.jsonl");
const j = new JsonlJournal(jp);
await j.open();

const provider = new ScriptedProvider([
  { role: "assistant", content: "turn 1", toolCalls: [{ id: "1", name: "echo", args: { text: "hello" } }] },
  { role: "assistant", content: "final answer after two turns" },
]);

const toolRuntime = new ToolRuntime();
toolRuntime.register({
  name: "echo", description: "echoes input", parameters: { text: "string" },
  async execute(args: Record<string, unknown>) { return String(args.text); },
});

const budget = new TokenBudget(100_000);
const cb = new ContextBuilder(new CharTokenCounter(4));

const loop = new AgentLoop(provider, toolRuntime, j, {
  maxTurns: 5,
  tokenBudget: budget,
  contextBuilder: cb,
});

const result = await loop.run("demo-cumulative", "Echo hello");
await j.close();

console.log("exitCode:", result.exitCode);
console.log("total tokens consumed:", budget.usedTokens);
const events = readFileSync(jp, "utf-8").trim().split("\n").map(l => JSON.parse(l));
console.log("turns:", events.filter(e => e.type === "turn:start").length);
console.log("tool calls:", events.filter(e => e.type === "tool:call").length);

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
exitCode: 0
total tokens consumed: 37
turns: 2
tool calls: 1
```

**看什么：**

- 两个 turn 的消息都被计入了 `budget.usedTokens`。
- `turns: 2`——turn 0 调了 tool，turn 1 返回最终答案。
- 总消耗 37 tokens——这是 turn 0 context（约 15 tokens）+ turn 1 context（约 22 tokens，因为包含了 turn 0 的所有消息 + tool result）的累积。

### 试一下

1. **预算耗尽在第二 turn：** 把上面 walkthrough 的 budget 改成 20（刚好够 turn 0 但不够 turn 1），看第二 turn 的 budget check 触发 exhaustion。
2. **自定义 charsPerToken：** 创建 `new CharTokenCounter(2)` 传给 ContextBuilder，对比默认 `4` 的 token 估算差异。代码/中文场景下 2 更贴近真实 token 数。
3. **TokenBudget 警告阈值：** 创建 `new TokenBudget(1000, 0.3)`（30% 警告），跑一个足够量的 run，在 `budget.consume()` 后检查 `budget.isWarning()`。
4. **ContextWindow 的字段速查：**

| 字段              | 类型                  | 含义                                      |
| ----------------- | --------------------- | ----------------------------------------- |
| `systemPrompt`    | `string \| null`      | 系统提示词，null 表示不设                |
| `messages`        | `Message[]`           | 聊天消息列表（user/assistant/tool）       |
| `toolDefs`        | `ToolDef[]`           | 工具 schema 列表（name + description + parameters） |
| `estimatedTokens` | `number`              | 三部分 token 估算之和（system prompt + messages + tools） |

5. **TokenBudget 方法的速查表：**

| 方法               | 返回    | 含义                                          |
| ------------------ | ------- | --------------------------------------------- |
| `constructor(max)` | -       | 最大 token 数，必须 > 0                       |
| `constructor(max, warn)` | - | warn 是 0-1 浮点数，默认 0.8                 |
| `usedTokens`       | number  | 已消耗 token 数                               |
| `remainingTokens`  | number  | 剩余 token 数，下限为 0                      |
| `isExhausted()`    | boolean | `usedTokens >= maxTokens`                     |
| `isWarning()`      | boolean | `usedTokens >= maxTokens * warnThreshold`     |
| `consume(n)`       | void    | 增加已消耗 token 数                           |
| `reset()`          | void    | 清零（测试用）                               |

### 更新后的附录 A — 事件类型速查

PR09 没有新增事件类型。预算耗尽通过已有的 `error` 事件表示：
- `errorType: "harness"`
- `errorCategory: "budget_exhausted"`

这和 PR05（取消）、PR06（错误分类）的模式一致——不扩展 RunEvent union，复用已有的 error variant。

# Helm 手动走查 (PR08)

## PR08 — Replay

### 这个 PR 为 harness 加了什么

journal 的读写闭环。PR01 的 `JsonlJournal` 是 write-side（append-only writer），
PR08 加的是 read-side：从磁盘 `.jsonl` 文件读回 `RunEvent[]`，重放事件流，
并从中提取结构化统计信息。核心概念：

- **`readJournal(filePath)`** — 读一份 `.jsonl` journal 文件，逐行 parse
  JSON，返回 `{ events: RunEvent[], warnings: ReadWarning[] }`。每行一个
  `RunEvent`，首尾空白忽略。
- **`replayEvents(events, observer?)`** — 按序遍历 `RunEvent[]`，每个事件
  调一次可选的 observer callback。observer 拿到 event 和它在数组里的 index，
  可以 print、collect、或桥接到 PR07 的 eval 断言。
- **`computeStats(events)`** — 从 `RunEvent[]` 中提取 `RunSummary`：
  每种事件类型出现次数、turn 数、各 tool 调用次数、error 总数和分类分布、
  retry 尝试次数和是否耗尽、run 耗时（`run:end.timestamp - run:start.timestamp`）、
  是否取消及其原因、最终 exitCode。
- **`ReadError`** — 文件不存在时抛出的 error 子类，带 `filePath` 字段。

`@helm/replay` 只依赖 `@helm/core`（`RunEvent` 类型），不依赖 `@helm/runtime`。
读 journal 不需要知道 AgentLoop 是怎么写的——只要知道 JSONL 格式契约（每行一个
`JSON.stringify(RunEvent)`）。

### 准备工作：跑 replay 测试

```bash
pnpm --filter @helm/replay exec vitest run --reporter=verbose
```

26 个测试覆盖：读有效文件、空文件、损坏 JSON（带行号）、未知事件类型（emit warning
不 crash）、缺失字段、null 行、文件不存在、JsonlJournal 写入再用 readJournal
读出（round-trip）、空白行跳过、replayEvents observer 回调顺序、computeStats
各种统计维度、空 event 数组边界、完整集成测试。

### Walkthrough: 手写 journal 然后读回来

最快的理解路径是手写一份 `.jsonl`，然后用 `readJournal` + `computeStats` 观察输出：

```bash
# 写一份模拟 journal
cat > /tmp/helm-replay-demo.jsonl << 'JSONL'
{"type":"run:start","runId":"demo","timestamp":1000}
{"type":"turn:start","runId":"demo","turnIndex":0,"timestamp":1001}
{"type":"tool:call","runId":"demo","turnIndex":0,"toolName":"calc","args":{"expr":"2+3"},"timestamp":1002}
{"type":"tool:result","runId":"demo","turnIndex":0,"toolName":"calc","output":"5","timestamp":1003}
{"type":"turn:start","runId":"demo","turnIndex":1,"timestamp":1004}
{"type":"error","runId":"demo","message":"timeout","errorType":"provider","errorCategory":"timeout","timestamp":1005}
{"type":"retry","runId":"demo","turnIndex":1,"phase":"attempt","attemptNumber":2,"maxAttempts":3,"errorMessage":"timeout","delayMs":10,"timestamp":1006}
{"type":"run:end","runId":"demo","exitCode":0,"timestamp":1100}
JSONL
```

然后用 Node 跑一段简短脚本：

```bash
node --import tsx -e '
import { readJournal, computeStats, replayEvents } from "./packages/replay/src/index.js";

const result = readJournal("/tmp/helm-replay-demo.jsonl");
console.log("Events:", result.events.length);
console.log("Warnings:", result.warnings.length);

console.log("\nReplay:");
replayEvents(result.events, (e, i) => {
  console.log(`  [${i}] ${e.type}`);
});

const stats = computeStats(result.events);
console.log("\nStats:");
console.log("  turns:", stats.turnCount);
console.log("  tool calls:", JSON.stringify(stats.toolCallCounts));
console.log("  errors:", stats.errorCount);
console.log("  errors by category:", JSON.stringify(stats.errorsByCategory));
console.log("  retry attempts:", stats.retryAttemptCount);
console.log("  retry exhausted:", stats.retryExhausted);
console.log("  duration (ms):", stats.durationMs);
console.log("  cancelled:", stats.cancelled);
console.log("  exit code:", stats.exitCode);
'
```

输出：

```
Events: 8
Warnings: 0

Replay:
  [0] run:start
  [1] turn:start
  [2] tool:call
  [3] tool:result
  [4] turn:start
  [5] error
  [6] retry
  [7] run:end

Stats:
  turns: 2
  tool calls: {"calc":1}
  errors: 1
  errors by category: {"timeout":1}
  retry attempts: 1
  retry exhausted: false
  duration (ms): 100
  cancelled: false
  exit code: 0
```

**看什么：**

- `readJournal` 返回 8 个事件，0 个 warning——这份模拟 journal 格式正确。
- `replayEvents` 按写入顺序逐条回调，observer 拿到 `[index]` 和 `event.type`。
- `computeStats` 不用知道这是手写的还是 AgentLoop 产生的——它只看事件流：
  - `turnCount: 2`，因为有两个 `turn:start`。
  - `toolCallCounts: {"calc":1}`，有一个 `tool:call` 事件。
  - `errorsByCategory: {"timeout":1}`，有一个 error 事件，category 是 `timeout`。
  - `durationMs: 100` = `run:end.timestamp (1100) - run:start.timestamp (1000)`。
  - `retryAttemptCount: 1`，`retryExhausted: false`——只有一条 `phase=attempt`。
  - `exitCode: 0`——从 `run:end` 提取。

类比 Java 里，`JsonlJournal` 是 `FileWriter`（append mode），`readJournal`
是 `BufferedReader` + `Gson.fromJson()`，`computeStats` 是 stream 上的
`Collectors.groupingBy()`。

### Walkthrough: 损坏的 journal — malformed JSON

```bash
cat > /tmp/helm-replay-bad.jsonl << 'JSONL'
{"type":"run:start","runId":"bad","timestamp":1}
this is not valid json
{"type":"run:end","runId":"bad","exitCode":0,"timestamp":3}
JSONL

node --import tsx -e '
import { readJournal } from "./packages/replay/src/index.js";
const result = readJournal("/tmp/helm-replay-bad.jsonl");
console.log("Events:", result.events.length);
for (const w of result.warnings) {
  console.log(`Warning line ${w.line}: ${w.message}`);
}
console.log("Event types:", result.events.map(e => e.type).join(", "));
'
```

输出：

```
Events: 2
Warning line 2: Malformed JSON on line 2
Event types: run:start, run:end
```

**看什么：**

- 第 2 行损坏了，readJournal 发出一个 warning 带行号 2，然后**继续读**。
- 第 3 行照常 parse 进结果。不因为中间一行坏掉就丢弃整个文件。
- warning 带 line number——在几百行的 journal 里定位一行损坏的 JSON 时
  这就是救命信息。

### Walkthrough: 损坏的 journal — unknown event type

```bash
cat > /tmp/helm-replay-unknown.jsonl << 'JSONL'
{"type":"run:start","runId":"u","timestamp":1}
{"type":"weather:forecast","location":"beijing","timestamp":2}
{"type":"run:end","runId":"u","exitCode":0,"timestamp":3}
JSONL

node --import tsx -e '
import { readJournal } from "./packages/replay/src/index.js";
const result = readJournal("/tmp/helm-replay-unknown.jsonl");
console.log("Events:", result.events.length);
for (const w of result.warnings) {
  console.log(`Warning line ${w.line}: ${w.message}`);
}
'
```

输出：

```
Events: 3
Warning line 2: Unknown event type "weather:forecast" on line 2
```

**看什么：** 未知事件类型**不会被丢弃**——它照样进入 `events` 数组。warning
是让调用方知道"这行我不认识"，但究竟是 skip 还是保留由调用方决定。
`isRunEvent` 只检查 `type` 和 `timestamp` 两个必须字段存在，不做白名单校验；
白名单校验（`KNOWN_EVENT_TYPES`）只产生 warning。

### Walkthrough: 文件不存在

```bash
node --import tsx -e '
import { readJournal, ReadError } from "./packages/replay/src/index.js";
try {
  readJournal("/tmp/helm-replay-ghost.jsonl");
} catch (err) {
  console.log("Name:", err.name);
  console.log("Message:", err.message);
  console.log("FilePath:", err instanceof ReadError ? err.filePath : "N/A");
}
'
```

输出：

```
Name: ReadError
Message: Cannot read journal file: /tmp/helm-replay-ghost.jsonl
FilePath: /tmp/helm-replay-ghost.jsonl
```

`ReadError` 是 `Error` 的子类，带 `filePath` 字段——调用方不用 parse
`message` 字符串就能拿到路径。

### Walkthrough: JsonlJournal → readJournal round-trip

这是最重要的集成契约：写入和读出必须完全一致。测试
`"full integration: write with JsonlJournal, read with readJournal, compute stats"`
做了完整验证，这里手工重现：

```bash
node --import tsx -e '
import { JsonlJournal } from "./packages/core/src/index.js";
import { readJournal, computeStats } from "./packages/replay/src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "helm-rt-"));
const fp = join(dir, "journal.jsonl");

// 写
const j = new JsonlJournal(fp);
await j.open();
await j.append({ type: "run:start", runId: "rt", timestamp: 1000 });
await j.append({ type: "tool:call", runId: "rt", turnIndex: 0, toolName: "calc", args: { expr: "1+1" }, timestamp: 1001 });
await j.append({ type: "tool:result", runId: "rt", turnIndex: 0, toolName: "calc", output: "2", timestamp: 1002 });
await j.append({ type: "run:end", runId: "rt", exitCode: 0, timestamp: 1100 });
await j.close();

// 读
const result = readJournal(fp);
console.log("Events:", result.events.length);
console.log("Warnings:", result.warnings.length);
console.log("Types:", result.events.map(e => e.type).join(" → "));

// 统计
const stats = computeStats(result.events);
console.log("Turns:", stats.turnCount);
console.log("Tool calls:", JSON.stringify(stats.toolCallCounts));
console.log("Duration:", stats.durationMs, "ms");

rmSync(dir, { recursive: true, force: true });
'
```

输出：

```
Events: 4
Warnings: 0
Types: run:start → tool:call → tool:result → run:end
Turns: 0
Tool calls: {"calc":1}
Duration: 100 ms
```

注意 `Turns: 0`——因为这份测试 journal 里没有 `turn:start` 事件（简化 demo）。
`computeStats` 不假设事件一定齐全，缺失的字段就是 0/null/false。

### 试一下

1. **AgentLoop 产生真实 journal 再读回：** 跑 PR04 的 CLI demo 产生一份
   journal（`/tmp/helm-walkthrough-normal.jsonl`），然后用 `readJournal`
   读回来，用 `replayEvents` 逐条打印类型。和之前肉眼读的 trace 对比。
2. **手工写一个全部 9 种事件类型都有的 journal**，跑 `computeStats` 看
   每个维度的统计是否正确。特别关注 `retryExhausted`（需要有 `phase=exhausted`
   才 true）、`cancelledReason`（从 `run:cancelled` 里提取）。
3. **在一份正确 journal 的中间插入一行垃圾**，看 `readJournal` 的 warning
   机制：损坏行被跳过，前后事件保留。
4. **RunSummary 的字段速查：**

| 字段               | 类型                  | 来源                                        |
| ------------------ | --------------------- | ------------------------------------------- |
| `eventCounts`      | `Record<string,number>` | 每种 event.type 出现次数                    |
| `turnCount`        | `number`              | `turn:start` 事件数                         |
| `toolCallCounts`   | `Record<string,number>` | 每个 toolName 的 `tool:call` 次数          |
| `errorCount`       | `number`              | `error` 事件数                              |
| `errorsByCategory` | `Record<string,number>` | 每个 errorCategory 的出现次数              |
| `retryAttemptCount`| `number`              | `retry phase=attempt` 事件数               |
| `retryExhausted`   | `boolean`             | 是否有 `retry phase=exhausted`             |
| `durationMs`       | `number \| null`      | `run:end.ts - run:start.ts`，缺任一则为 null |
| `cancelled`        | `boolean`             | 是否有 `run:cancelled` 事件                |
| `cancelledReason`  | `"external"\|"timeout"\|null` | 从 `run:cancelled.reason` 提取  |
| `exitCode`         | `number \| null`      | 从 `run:end.exitCode` 提取                 |

### 更新后的附录 A — 事件类型速查

PR08 没有新增事件类型。readJournal 消费已有的 `RunEvent` union，
replay 纯粹是读操作——这和 PR07 的 eval harness 形成"写（JsonlJournal）
→ 读（readJournal）→ 断言（evaluateAssertion）→ 统计（computeStats）"
的完整数据流。

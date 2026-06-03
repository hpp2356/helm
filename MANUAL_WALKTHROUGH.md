# Helm 手动走查 (PR07)

## PR07 — Eval Harness

### 这个 PR 为 harness 加了什么

一个工作在 journal 事件层之上的 **eval 断言框架**。和单元测试（验证代码返回值）
不同，eval harness 跑完整的 `AgentLoop`，然后检查 journal 里是否出现了
期望的事件模式。核心概念：

- **EvalCase** — 一个命名场景：一份 `ScriptedProvider` 脚本 + 可选的 tools +
  一组断言。纯数据，可 JSON 序列化（除 tool 的 execute 函数外）。
- **EvalAssertion** — 六种断言类型，discriminated union：
  `event:exists`、`event:order`、`tool:called`、`final:answer`、
  `error:category`、`no:error`。
- **EvalRunner** — 取一个 EvalCase，跑 AgentLoop，从 journal 读回事件，
  逐条评估断言，返回结构化结果。不掉 agent 内部状态，只读 journal。
- **EvalResult / EvalSuiteResult** — 每条断言的 pass/fail + 诊断信息，
  以及跨多个 case 的聚合摘要。

eval harness 是 PR08（Replay）和 PR12（第一个真实 provider）的基础——
replay 要重放 journal 来验证行为，eval 要先定义"什么叫正确的行为"。

> **已知缺口：** `final:answer` 断言依赖 agent 最终输出的文本，但当前
> `AgentLoop` 不会把 assistant 消息写入 journal。PR07 的 eval runner 通过
> 一个轻量 `CapturingProvider` wrapper 在内存中捕获消息来解决这个问题。
> 未来 PR 会把 `message` 事件加入 journal，届时 `final:answer` 就能完全
> 从 journal 断言。

### 准备工作：跑 eval 测试

eval 暂时没有 CLI，通过 vitest 观察行为：

```bash
pnpm --filter @helm/eval exec vitest run --reporter=verbose
```

这个命令跑 27 个测试，覆盖了所有六种断言类型的单元测试和 EvalRunner 集成测试。

### Walkthrough: 看一个通过的 EvalCase

`evaluateAssertion` 是断言引擎的核心函数，签名是：

```ts
function evaluateAssertion(
  assertion: EvalAssertion,
  events: RunEvent[],
  capturedMessages: Message[],
): EvalResult
```

下面这段逻辑在测试 `"passes all assertions for a valid case with tool calls and final answer"`
里完整跑了一遍。手工构造等价的 journal 事件，逐条看每个断言怎么通过：

```ts
// 模拟 AgentLoop 产生的 journal：
const events: RunEvent[] = [
  { type: "run:start", runId: "test", timestamp: 1 },
  { type: "turn:start", runId: "test", turnIndex: 0, timestamp: 2 },
  { type: "tool:call", runId: "test", turnIndex: 0, toolName: "calc",
    args: { expr: "6*7" }, timestamp: 3 },
  { type: "tool:result", runId: "test", turnIndex: 0, toolName: "calc",
    output: "result: 6*7 = 42", timestamp: 4 },
  { type: "run:end", runId: "test", exitCode: 0, timestamp: 5 },
];

// 断言 1：journal 里有 tool:call 事件
evaluateAssertion(
  { type: "event:exists", eventType: "tool:call" }, events, []
);
// => { pass: true, actual: ["run:start","turn:start","tool:call",
//                          "tool:result","run:end"],
//      expected: "tool:call" }

// 断言 2：calc 工具被调用过
evaluateAssertion(
  { type: "tool:called", toolName: "calc" }, events, []
);
// => { pass: true, actual: [{ toolName: "calc", args: { expr: "6*7" } }],
//      expected: { toolName: "calc" } }

// 断言 3：最后一条 assistant 消息包含 "42"（从 capturedMessages 检查）
const messages = [
  { role: "assistant", content: "Let me calculate",
    toolCalls: [{ id: "1", name: "calc", args: { expr: "6*7" } }] },
  { role: "assistant", content: "The answer is 42" },
];
evaluateAssertion(
  { type: "final:answer", contains: "42" }, [], messages
);
// => { pass: true, actual: "The answer is 42",
//      expected: { contains: "42" } }

// 断言 4：没有任何 error 事件
evaluateAssertion(
  { type: "no:error" }, events, []
);
// => { pass: true, actual: [], expected: "no errors" }
```

**看什么：**

- 四个断言全部通过。`actual` 字段告诉你真实观察到的值——这是诊断的关键。
- `event:exists` 的 `actual` 是完整事件类型序列，方便你一眼看出 journal
  里到底有哪些事件。
- `tool:called` 不传 `args` 时只校验工具名；传了 `args` 则做**子集匹配**
  （expected 的每个 key 在 actual args 中值相等即可，actual 可以有多余的 key）。
- `final:answer` 读的是 `capturedMessages`（内存中的 provider 响应快照），
  不是 journal——这是 PR07 的唯一例外。`contains` 做子串匹配，
  `matches` 做精确匹配。两个都指定时两个都必须通过。
- `no:error` 检查 journal 里不存在任何 `type === "error"` 的事件。

### Walkthrough: 看一个失败的 EvalCase

测试 `"fails on event:exists when expected event type is absent"`
构造了一个只有一个 final answer 的 case（没有 tool calls），然后断言
`tool:call` 存在——必然失败：

```ts
const evalCase: EvalCase = {
  name: "no tool calls",
  script: [{ role: "assistant", content: "Done" }],
  assertions: [
    { type: "event:exists", eventType: "tool:call" },
  ],
};
const result = await runner.runCase(evalCase);
// result.pass === false
// result.results[0] 内容：
// {
//   assertion: { type: "event:exists", eventType: "tool:call" },
//   pass: false,
//   actual: ["run:start", "turn:start", "run:end"],
//   expected: "tool:call",
//   message: 'expected event "tool:call" not found'
// }
```

**看什么：**

- journal 里只有 `run:start`、`turn:start`、`run:end`——因为脚本
  `[{ role: "assistant", content: "Done" }]` 没有 toolCalls，
  AgentLoop 在第一个 turn 就收到纯文本回复然后 break 了。
- `actual` 清楚告诉你"我看到了这三个事件"，而 `expected` 是没找到的那个。
- `message` 是人类可读的失败原因。

再看一个 `tool:called` 的失败——把工具名叫错了：

```ts
const evalCase: EvalCase = {
  name: "wrong tool assertion",
  script: [
    { role: "assistant", content: "echo this",
      toolCalls: [{ id: "1", name: "echo", args: { text: "hello" } }] },
    { role: "assistant", content: "Done" },
  ],
  tools: [echoTool],
  assertions: [
    { type: "tool:called", toolName: "calc" },  // 错了——应该叫 "echo"
  ],
};
// result.results[0]:
// {
//   pass: false,
//   actual: [{ toolName: "echo", args: { text: "hello" } }],
//   expected: { toolName: "calc" },
//   message: 'expected tool "calc" to be called'
// }
```

`actual` 告诉你"我确实看到了 tool call，但名字是 `echo` 而不是你期望的
`calc`"——一眼就能定位问题。

### Walkthrough: 错误分类断言

PR06 引入了 `error` 事件上的 `errorCategory` 字段。PR07 的
`error:category` 断言利用这个字段检查是否产生了特定类型的错误：

```ts
// 用 ScriptedProvider 注入一个 rate_limit 错误
const evalCase: EvalCase = {
  name: "error injection",
  script: [
    { _error: true, message: "rate limit hit", category: "rate_limit" },
  ],
  assertions: [
    { type: "error:category", errorCategory: "rate_limit" },
  ],
};
const result = await runner.runCase(evalCase);
// result.pass === true
```

匹配逻辑：`error:category` 先匹配事件的 `errorCategory` 字段，如果没命中
再 fallback 到 `errorType`——所以 `{ type: "error:category",
errorCategory: "provider" }` 也能匹配到 `errorType === "provider"` 的
事件。

### Walkthrough: 事件顺序断言（subsequence）

`event:order` 不做精确的一对一序列匹配，而是做**子序列匹配**
（subsequence）——期望的类型必须按顺序出现在实际事件流中，但不要求连续：

```ts
const events = [
  { type: "run:start", ... },
  { type: "turn:start", ... },
  { type: "tool:call", ... },
  { type: "tool:result", ... },
  { type: "run:end", ... },
];

// 通过 — run:start 出现在 tool:call 前面，tool:call 出现在 run:end 前面
evaluateAssertion(
  { type: "event:order",
    eventTypes: ["run:start", "tool:call", "run:end"] },
  events, []
); // => pass: true

// 失败 — tool:call 在 run:start 后面（期望 run:start 在 tool:call 后面）
evaluateAssertion(
  { type: "event:order",
    eventTypes: ["tool:call", "run:start"] },
  events, []
); // => pass: false
```

这种设计允许你在不关心中间插入了什么事件的情况下验证因果顺序——比如
"先有 turn:start，然后有 tool:call，最后有 run:end"，中间有没有
tool:result、retry 之类的不影响断言。

### Walkthrough: 跑一个 suite（多 case 聚合）

`EvalRunner.runSuite` 接受一个 `EvalCase[]`，逐个 case 跑完，返回
`EvalSuiteResult`：

```ts
const suiteResult = await runner.runSuite([passingCase, failingCase]);
// suiteResult.totalCases === 2
// suiteResult.passedCases === 1
// suiteResult.failedCases === 1
// suiteResult.totalAssertions === 3
// suiteResult.passedAssertions === 2
// suiteResult.failedAssertions === 1
```

`suitResult.summary` 是人类可读的文本：

```
Cases: 1/2 passed
  PASS  passing
  FAIL  failing
    X expected event "tool:call" not found
Assertions: 2/3 passed
```

这和 `deno test` 或 `pytest -v` 的输出风格一致——一眼看出哪个 case 挂了、
挂了几个断言、失败原因是什么。

### 试一下

1. **读 eval 测试：** 打开 `packages/eval/src/index.test.ts`，从
   `evaluateAssertion` 的 describe 块开始读。每个断言类型的 pass/fail
   行为都在单独测试里，对照 `packages/eval/src/index.ts` 的
   `evaluateAssertion` 函数看 switch-case 分支。
2. **手动构造一个 case 跑：** 仿照 `"simple calc"` 测试里的 EvalCase
   结构，构造一个自己的 case，用 `echoTool` 代替 `calcTool`，
   然后 `node --import tsx -e "..."` 跑 `runner.runCase(yourCase)`。
   观察返回的 `EvalCaseResult`。
3. **改错一个断言看失败输出：** 拿 `"simple calc"` case，把
   `{ type: "final:answer", contains: "42" }` 改成
   `{ type: "final:answer", contains: "999" }`，重新跑测试，
   看 `result.results[2]` 里的 `message` 和 `actual`。
4. **理解 event:order 的子序列语义：** 在 `packages/eval/src/index.test.ts`
   里找到 `"passes when expected types appear in order (subsequence)"`
   测试，把 `eventTypes` 改成故意不对的顺序（如
   `["tool:call", "run:start"]`），看断言失败。
5. **trace 一次真实 run 的 journal：** 在 `EvalRunner.runCase` 的
   `readJournal` 调用附近的代码里，临时把读取到的 `events` dump 到
   `console.log`，看一次完整 AgentLoop 产生的真实事件序列。
6. **六种断言的速查表：**

| 断言类型          | 检查什么                                             | 数据源             |
| ----------------- | ---------------------------------------------------- | ------------------ |
| `event:exists`    | 指定 eventType 的事件至少出现一次                     | journal events     |
| `event:order`     | 指定 eventTypes 作为子序列出现在事件流中              | journal events     |
| `tool:called`     | 指定名称的 tool 被调用过，可选 args 子集匹配          | journal events     |
| `final:answer`    | 最后一条 assistant 消息的 content 包含/匹配指定字符串 | captured messages  |
| `error:category`  | 至少一条 error 事件的 errorCategory 或 errorType 匹配 | journal events     |
| `no:error`        | 没有任何 error 事件                                   | journal events     |

### 更新后的附录 A — 事件类型速查

PR07 没有新增事件类型。eval harness 操作的是已有的 `RunEvent` union——
它证明了 "不修改 AgentLoop 就能从 journal 断言行为" 这个架构是可行的。

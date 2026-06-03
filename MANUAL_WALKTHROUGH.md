# Helm 手动走查 (PR00–PR07)

## 如何使用本文档

这是一份**读 trace 的练习**，不是测试用例。Vitest 已经覆盖了正确性，本文档
覆盖的是**理解**。每个 PR 都会往 journal 里加新的事件类型或者新的 harness 机制，
而 JSONL journal 就是这些机制在运行时唯一会留下痕迹的地方 —— 类比 SLF4J 的
结构化日志，但是是把 agent run 当事件溯源（Event Sourcing）来记录。每个命令
跑完以后，你会打开一个 `.jsonl` 文件去读它产生的事件；重点是
"这个 PR 在 trace 里多出了什么"。

PR00–PR03 没有给最终用户暴露 CLI —— 这几个 PR 只落在 `packages/core` 和
`packages/runtime`，所以我们通过它们的单元测试来观察。可执行的 CLI
（`packages/cli/bin/run.js`）从 PR04 开始才有，从 PR04 起我们就用它。

## 前置准备 (只跑一次)

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

CLI 跑完产生的 journal 会落在 `/tmp/helm-<runId>.jsonl`。CLI 在输出最底下会
打印精确路径。

```bash
ls /tmp/helm-*.jsonl 2>/dev/null   # 看自己跑出来过哪些 journal
```

## PR00 — 引导 monorepo

### 这个 PR 给 harness 加了什么

TypeScript pnpm workspace 本身：`packages/core`、`packages/runtime`、
`packages/eval`、`packages/replay`，还有共用的 `tsconfig.base.json` 和
根目录脚本（`typecheck`、`test`、`build`）。

### 走查

还没有 journal。验证 workspace 能编译：

```bash
pnpm install
pnpm build
pnpm typecheck
```

应该看到 5 个 package 都干净通过（`@helm/core`、`@helm/runtime`、
`@helm/eval`、`@helm/replay`、`@helm/cli` —— 最后一个要等 PR04 才有）。
没别的可看的；这个 PR 是纯基础设施，类比 Java 里在还没写任何模块代码之前
对一个全新的多模块 Maven 父工程跑 `mvn -N install`。

## PR01 — RunEvent + JsonlJournal

### 这个 PR 给 harness 加了什么

第一份持久化产物：一个 discriminated-union 的 `RunEvent` 类型，外加一个
`JsonlJournal` writer，每行 append 一个 JSON 对象。这一步 journal 还没
被任何东西读 —— loop 和 tools 都还没有 —— 所以唯一能看到它跑起来的方式
就是 journal 自己的测试。

### 走查

```bash
pnpm --filter @helm/core exec vitest run src/journal.test.ts --reporter=verbose
```

会看到 6 个绿色测试。比较有意思的两个：

- `should append multiple events as separate JSONL lines` —— 证明契约：
  每次 `append(event)` 写恰好一行，行内不嵌入 newline。
- `should reopen and append to an existing file` —— `open` 用的是 `"a"`
  模式，所以 journal 跨多次运行都是 append-only。

要**看**这些事件序列化之后长什么样，去读
`packages/core/src/events.test.ts` —— `RunEvent` 的每个 variant 都在那里
被构造出来。PR01 那一批是：`run:start`、`run:end`、`turn:start`、
`turn:end`、`tool:call`、`tool:result`、`error`。（`run:cancelled` 是
PR05 才加的。）

### 试一下

打开 `packages/core/src/events.ts` 扫一眼这个 union。后面每个 PR 要么发出
里面已经有的 variant，要么扩展这个 union —— 这个文件就是一份单页契约，
说明一次 run 期间能发生哪些事。

> 老实说一句：`turn:end` 在 union 里是**声明了**的，但 AgentLoop 从来没
> 真的发过它。`turn:start` 才是你在任何真实 journal 里能看到的唯一
> turn 边界事件。PR02–PR05 也都是这样；这里先标出来，免得你白跑去找。

## PR02 — ScriptedProvider + 最小 AgentLoop

### 这个 PR 给 harness 加了什么

一个玩具 `Provider`（`ScriptedProvider`），按顺序返回一份预先准备好的
`Message` 列表；外加一个 `AgentLoop`，驱动每一个 turn：找 provider 要
一条消息，写 journal，等 assistant 不再返回 tool calls 或者 `maxTurns`
打到了就停。

这一步还没有 tool 调用 —— `tool:call` / `tool:result` 要到 PR03 把它们
接进来才会出现。所以 PR02 的 AgentLoop 只会产生 `run:start`、
`turn:start`、`run:end`。

### 走查

PR03 加进来的端到端 runtime 测试会把 journal 直接打到屏幕上，但 PR02
自己也带了 AgentLoop 的测试：

```bash
pnpm --filter @helm/runtime exec vitest run src/agent-loop.test.ts --reporter=verbose
```

第一个测试 **"runs a simple no-tool turn"** 断言：单消息脚本下的 journal
正好是三行：

```
run:start
turn:start
run:end
```

这就是 PR02 的最小集合：开一个 run，跑一个 turn，关掉 run。

### 试一下

去看 `packages/runtime/src/agent-loop.ts:30` —— 那个遍历 turn 的 `for`
循环。退出条件 `response.toolCalls?.length > 0` 就是 PR02 里"agent"全部的
决策：assistant 要 tool 就继续，不要就停。PR03 才填进去"要 tool"具体
做什么。

## PR03 — ToolRuntime

### 这个 PR 给 harness 加了什么

一个 `ToolRuntime` 注册表，外加 AgentLoop 里的接线：当 assistant 消息
带 `toolCalls` 时，先写一个 `tool:call`，跑这个 tool，写 `tool:result`，
然后把结果作为一条 `role: "tool"` 消息塞回消息历史。

这是 journal 第一次真正长得像 agent trace 的 PR：
turn → tool:call → tool:result → turn。

### 走查

`runtime` package 自带一个会把结果打到屏幕的端到端 demo 测试：

```bash
pnpm --filter @helm/runtime exec vitest run src/demo.test.ts --reporter=verbose
```

在测试的 `stdout` 段里你会按顺序看到 journal：

```
🚀 [hh:mm:ss] RUN START   id=demo-run-1
🔄 [hh:mm:ss] TURN 0 START
🔧 [hh:mm:ss] TOOL CALL   calculator({"expression":"2 + 3 * 4"})
📤 [hh:mm:ss] TOOL RESULT Result: 14
🔄 [hh:mm:ss] TURN 1 START
✅ [hh:mm:ss] RUN END     exitCode=0
Total: 6 events
```

`tool:call` 和 `tool:result` 是这个 PR 新加的事件。还要注意**第二个**
`turn:start` —— turn 0 跑了 tool，turn 1 又一次去问 provider（assistant
的消息历史里现在有了 tool 输出），这次 provider 给的最终回答里没有
`toolCalls`，所以 loop 结束。

### 试一下

打开 `packages/runtime/src/agent-loop.ts:62`。里面那个
`for (const tc of response.toolCalls)` 内层循环，就是把一条 assistant
消息变成 N 对 `tool:call` / `tool:result` 事件的地方。`tc.id` 是后续 turn
用来把 `role: "tool"` 回消息匹配回正确那次 call 的字段 —— 跟
OpenAI/Anthropic 的 tool-use ID 是同一个思路。

## PR04 — Permission/Risk + 最小 CLI

### 这个 PR 给 harness 加了什么

PR04 一次性塞了两件事：

1. `PermissionRuntime`，带 `RiskLevel`（`LOW`、`MEDIUM`、`HIGH`、
   `CRITICAL`），allow/deny 规则，pattern 匹配（尾部 `*` 当通配符）。
   接进了 `ToolRuntime`：每次 `execute()` 之前，先问 `PermissionRuntime`
   这次调用允不允许。
2. `packages/cli/bin/run.js` —— 第一个面向用户的可执行入口。它加载
   tools 文件、script 文件、perms 文件，构造一个真正的 AgentLoop，
   并实时把 journal 打到 stdout。

被 deny 的 tool 调用**不会**让 run 崩 —— `tool:result` 事件会把这次
拒绝当作 tool 的"输出"记下来，这样 assistant 在后续 turn 里还能根据
这个反馈做反应。（没有新 event variant：权限拒绝复用 `tool:result`。）

### 走查 —— 允许的 run

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-normal
cat /tmp/helm-walkthrough-normal.jsonl
```

fixture 里的 `perms.json` 把 `calculator` 设成 MEDIUM allow，把 `weather`
设成 LOW allow。journal 看起来跟 PR03 demo 的 trace 一样 —— 同样 6 个
事件。新东西藏在 `ToolRuntime.execute` 里：在把活儿交给 tool 之前，
它先去问 `PermissionRuntime`。因为规则是 `allow`，trace 里看不出区别。
（这正是要点 —— allow 是一条"沉默"的路径。）

### 走查 —— 被拒绝的 run

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms-deny-calc.json \
  walkthrough-deny
cat /tmp/helm-walkthrough-deny.jsonl
```

`perms-deny-calc.json` 里 `calculator` 同时有一条 allow 和一条 deny，
deny 标的是 CRITICAL risk。Deny 胜出。trace 里的 `tool:result` 这一行
带着拒绝信息：

```json
{"type":"tool:result","runId":"walkthrough-deny","turnIndex":0,"toolName":"calculator",
 "output":"Error: permission denied — Tool \"calculator\" is denied: calculator blocked for demo (risk: CRITICAL)",
 "timestamp":...}
```

run 仍然以 `exitCode=0` 结束 —— 权限拒绝是 tool 层的产出，不是 run 层的
失败。

### 试一下

打开 `packages/cli/fixtures/perms-deny-calc.json`，把 deny 那条的 risk
改成 `LOW`，再跑一遍。无论 risk 等级是什么，deny 都还是赢 —— risk
只是规则的元数据，不参与优先级判断。去 `packages/runtime/src/permission-runtime.ts`
确认一下：deny 规则会比 allow 规则先被检查，risk level 只是被原样塞进
拒绝信息里。

## PR05 — Cancellation / Timeout

### 这个 PR 给 harness 加了什么

- `run:cancelled` 事件，带 `reason: "external" | "timeout"`。
- `Tool.execute` 和 `Provider.send` 多了可选的 `signal?: AbortSignal`。
- `AgentLoop` 接受 `signal` 和 `maxDurationMs` 选项。内部建一个
  `AbortController`，外部 signal 或者 `setTimeout(maxDurationMs)` 任一
  触发都会调它的 `abort()`。signal 在 turn 边界、`provider.send` 前后、
  以及每次 `tool.execute` 前后被检查。
- 取消会以退出码 `130` 结束（SIGINT 的惯例）。
- CLI 多了 `--timeout=<ms>` 和一个 `SIGINT` handler。还有一个没在用法里
  写出来的辅助 flag `--turn-delay-ms=<ms>`，它会把 provider 包一层人造
  延迟；用来在 scripted provider（否则瞬间返回）面前演示 cancellation
  很方便。

### 走查 —— 正常退出

跟 PR04 那条允许的 run 命令一样，为了完整性再跑一遍：

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-normal
echo "exit=$?"   # → 0
```

trace 以 `run:end exitCode=0` 收尾。没有 `run:cancelled` 事件。
说明在没配 timeout 的情况下，timeout 那条路径根本没进。

### 走查 —— 超时

scripted provider 是瞬间返回的，所以如果不放慢它，timeout 就没东西可以
触发。`--turn-delay-ms` 给每次 provider 调用注入 200 ms 延迟，
`--timeout=50` 在 50 ms 后触发内部 abort：

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-timeout \
  --timeout=50 --turn-delay-ms=200
echo "exit=$?"   # → 130
cat /tmp/helm-walkthrough-timeout.jsonl
```

trace：

```
run:start
turn:start (turnIndex 0)
run:cancelled reason=timeout
run:end exitCode=130
```

中断发生在 `provider.send` 内部 —— turn 0 已经开始但没跑完，所以这个
turn 里看不到 `tool:call`。慢 provider 包装层里的 abort listener 用一个
`AbortError` reject 掉了那个还在跑的 `setTimeout`；AgentLoop 看到
`controller.signal.aborted` 是 true，把它路由成 `run:cancelled` 事件
而不是 `error` 事件。

### 走查 —— Ctrl-C

开一个 shell：

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-sigint \
  --turn-delay-ms=2000
```

在第 1 秒之内按 **Ctrl-C**。会看到：

```
^C received — cancelling run...
🛑 [hh:mm:ss] CANCELLED    reason=external
✅ [hh:mm:ss] RUN END      exitCode=130
```

`cat /tmp/helm-walkthrough-sigint.jsonl` 确认事件：

```
run:start
turn:start (turnIndex 0)
run:cancelled reason=external
run:end exitCode=130
```

形状跟 timeout 那条一样，只是 `reason=external`。CLI 的 `SIGINT` handler
对自己那个 `AbortController` 调了 `abort()`，这个 controller 是作为
`options.signal` 传给 `AgentLoop` 的 —— loop 里那个合并的内部 controller
也跟着 abort，正在跑的 provider 调用 reject 掉，最后落到 external
取消那个分支。

### 试一下

把 timeout case 改成 `--timeout=5` 再跑一次（让定时器在 provider 都还
没被调用之前就触发）。`run:cancelled` 事件还是会出现，但有时候你会发现
它在任何 `turn:start` 之前就出现了 —— loop 的 pre-loop 取消检查
（`agent-loop.ts:81`）会在 `run:start` 之后立刻拦下"已经 abort"的 signal。
对比一下 `--timeout=50 --turn-delay-ms=200`，那个会先有一个
`turn:start`。这能告诉你：到底是哪个边界检查抓到了取消。

## 附录 A —— 事件类型速查

源头：`packages/core/src/events.ts`。

| 事件               | 引入的 PR     | 含义                                                            |
| ------------------ | ------------- | --------------------------------------------------------------- |
| `run:start`        | PR01          | 一次 run 开启；每个 journal 的第一个事件                        |
| `run:end`          | PR01          | run 结束；带 `exitCode`（0 正常，130 被取消）                   |
| `turn:start`       | PR01          | agent turn 开始；每次 loop 迭代顶部发一次                       |
| `turn:end`         | PR01          | _声明了但从来没被发出_ —— 见 PR01 那段的"老实说一句"            |
| `tool:call`        | PR01 (类型) / PR03 (发出) | assistant 用这些 args 请求了一个 tool                |
| `tool:result`      | PR01 (类型) / PR03 (发出) | tool 返回了这个输出（PR04 起也可能是权限拒绝信息）   |
| `error`            | PR01 (类型) / PR02 (发出) | provider 抛了一个不是 abort 引起的异常               |
| `run:cancelled`    | PR05          | run 因为外部 abort 或 timeout 在结束；带 `reason`               |

每个 variant 的精确字段形状在 `events.ts` 顶部。目前还没有可选的 schema
版本字段 —— 任何 consumer 都得接受所有 variant，不然就得改 `core` 的代码。

## 附录 B —— IDE 调试 (可选)

故意没做。CLI 是从编译产物 `packages/cli/dist/bin/run.js` 跑起来的，要
让 VS Code 的 launch config 跑起来，要么得另接一套 `tsx`/source map，
要么得走"先 build 再 attach"的流程。今天 repo 里这两条都没接，凭空
编一个没测过的版本会违背本指南的精神。如果你现在就想下断点，最简单
能跑通的做法是：

```bash
node --inspect-brk packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  debug-run
```

然后用 VS Code 的 "Node: Attach" 配置 attach 到 `localhost:9229`。因为
`tsconfig.base.json` 默认就开了 source map，`tsc` 编出来是带 source map
的，所以 `packages/runtime/src/agent-loop.ts` 里的断点会在编译产物跑到
对应行的时候命中。这条路能跑，但 repo 里没接 —— 真要加一份
`.vscode/launch.json` 应该等我们对调试方案达成共识之后再单独开 PR。

## PR06 — 错误分类与重试

### 这个 PR 为 harness 加了什么

一套 discriminated-union 错误分类（`AgentError = ProviderError | ToolError |
HarnessError`），每种错误带 `retryable` 标记；新的 `retry` journal 事件记录
每次重试尝试和耗尽；可配置的 `RetryPolicy`（指数退避 + jitter）；以及
`ScriptedProvider` 支持注入 scripted error 来模拟不稳定的 provider。

### 准备工作：跑 PR06 demo 的脚本

PR06 的 retry 功能还没接到 CLI（CLI 只加了 `retryPolicy` 选项但 run.ts
还没传进去），所以我们需要一个简短的 Node 脚本来构造带 `RetryPolicy`
的 `AgentLoop` 并注入 scripted error。把下面这段保存为 `pr06-demo.mjs`
放在仓库根目录：

```bash
cat > pr06-demo.mjs << 'SCRIPT'
// PR06 Retry Demo — 保存到仓库根目录，从仓库根目录运行：
//   node pr06-demo.mjs <scenario>
// Scenarios: non-retryable | retry-success | retry-exhausted | cancel-backoff
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const { JsonlJournal } = await import(join(root, 'packages/core/dist/index.js'));
const { ScriptedProvider, AgentLoop, ToolRuntime, DEFAULT_RETRY_POLICY } =
  await import(join(root, 'packages/runtime/dist/index.js'));

const FAST = {
  ...DEFAULT_RETRY_POLICY,
  baseDelayMs: 10, maxDelayMs: 50, jitter: false,
};
const SLOW = { ...FAST, baseDelayMs: 5000, maxDelayMs: 10000 };

const SCENARIOS = {
  'non-retryable': {
    responses: [
      { _error: true, message: 'invalid API key', category: 'auth_failure' },
      { role: 'assistant', content: 'never reached' },
    ],
    policy: FAST,
  },
  'retry-success': {
    responses: [
      { _error: true, message: 'rate limit exceeded', category: 'rate_limit' },
      { role: 'assistant', content: 'recovered on retry!' },
    ],
    policy: FAST,
  },
  'retry-exhausted': {
    responses: [
      { _error: true, message: 'server error 500', category: 'server_error' },
      { _error: true, message: 'server error 500', category: 'server_error' },
      { _error: true, message: 'server error 500', category: 'server_error' },
    ],
    policy: FAST,
  },
  'cancel-backoff': {
    responses: [
      { _error: true, message: 'server error', category: 'server_error' },
      { role: 'assistant', content: 'never reached' },
    ],
    policy: SLOW,
    abortAfterMs: 30,
  },
};

const name = process.argv[2];
if (!name || !SCENARIOS[name]) {
  console.error('Usage: node pr06-demo.mjs <scenario>');
  console.error('Scenarios: ' + Object.keys(SCENARIOS).join(', '));
  process.exit(1);
}

const s = SCENARIOS[name];
const dir = await mkdtemp(join(tmpdir(), 'helm-pr06-'));
const jp = join(dir, 'run.jsonl');
const j = new JsonlJournal(jp);
await j.open();

const ac = s.abortAfterMs ? new AbortController() : undefined;
const provider = new ScriptedProvider(s.responses);
const tr = new ToolRuntime();
const loop = new AgentLoop(provider, tr, j, {
  maxTurns: 5,
  retryPolicy: s.policy,
  ...(ac ? { signal: ac.signal } : {}),
});

let result;
if (ac && s.abortAfterMs) {
  const promise = loop.run(name, 'test');
  await new Promise((r) => setTimeout(r, s.abortAfterMs));
  ac.abort();
  result = await promise;
} else {
  result = await loop.run(name, 'test');
}

await j.close();
const events = (await readFile(jp, 'utf-8'))
  .trim().split('\n').map((l) => JSON.parse(l));

console.log(
  'exitCode=' + result.exitCode +
  (result.cancelled ? ' cancelled=' + result.cancelled.reason : ''),
);
for (const e of events) {
  let x = '';
  if (e.type === 'error')
    x = ' [' + (e.errorType || '?') + '/' + (e.errorCategory || '?') + '] ' +
      JSON.stringify(e.message);
  if (e.type === 'retry')
    x = ' phase=' + e.phase + ' attempt=' + e.attemptNumber + '/' +
      e.maxAttempts + ' delayMs=' + e.delayMs;
  if (e.type === 'run:cancelled') x = ' reason=' + e.reason;
  if (e.type === 'run:end') x = ' exitCode=' + e.exitCode;
  console.log(e.type + x);
}
console.log('\nJournal → ' + jp);
SCRIPT
```

每次 walkthrough 都是 `node pr06-demo.mjs <scenario>`，记下退避延迟和事件
顺序的规律。

### Walkthrough: 正常执行（无错误）

PR06 不改变无错误路径的行为。用 CLI demo 验证：

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  pr06-normal
cat /tmp/helm-pr06-normal.jsonl
```

预期 trace（与 PR05 完全一致，没有 `error` 也没有 `retry`）：

```
run:start
turn:start (turnIndex 0)
tool:call  calculator({"expression":"2+3"})
tool:result ["expression=2+3"]
turn:start (turnIndex 1)
run:end exitCode=0
```

**看什么：** 没有 `retryPolicy` 的时候，AgentLoop 每条 turn 最多调一次
provider。不会出现 `retry` 事件。

### Walkthrough: 不可重试错误

```bash
node pr06-demo.mjs non-retryable
```

trace：

```
run:start
turn:start
error [provider/auth_failure] "invalid API key"
run:end exitCode=0
```

**看什么：** `error` 事件现在带 `errorType=provider` 和
`errorCategory=auth_failure`。因为 `auth_failure` 的 `retryable` 是
`false`，`shouldRetry()` 返回 false，agent 不重试直接终止当前 turn。
trace 里**没有** `retry` 事件 —— 不可重试错误就是"跳过一次 retry 尝试
都没有"。`exitCode=0`：只有 retry 耗尽才设 exitCode=1，非重试错误等同
于 provider 给出了确定性的"不行"——类比 HTTP 401 不需要重试。

> 也可以把 `auth_failure` 改成 `unknown`（同样不可重试），效果一样。
> `providerError` helper 在 `packages/core/src/errors.ts` 里维护了每种
> category → retryable 的映射表。

### Walkthrough: 可重试错误 + 重试成功

```bash
node pr06-demo.mjs retry-success
```

trace：

```
run:start
turn:start
error [provider/rate_limit] "rate limit exceeded"
retry phase=attempt attempt=2/3 delayMs=10
run:end exitCode=0
```

**看什么：**

1. `error` 事件 `errorCategory=rate_limit`，这条的 `retryable=true`。
2. `retry phase=attempt` —— agent 判定错误可重试，决定等 `delayMs=10`
   毫秒后发起第 2 次尝试（`attempt=2/3`）。因为 `baseDelayMs=10`、
   `jitter=false`、第一次重试（retryIndex=0），延迟 = 10 × 2^0 = 10 ms。
3. 重试成功 —— provider 的下一条响应是 `{ role: "assistant", content:
   "recovered on retry!" }`，没有 toolCalls，所以 turn 结束，run 以
   exitCode=0 收尾。

注意 `turn:start` 只出现了一次 —— 重试发生在**同一个 turn 内部**，不是
新开一个 turn。`ScriptedProvider` 的错误注入把 `_error` entry 消费掉之后，
下一次 `send()` 自动前进到下一个正常 entry。

### Walkthrough: 重试耗尽

```bash
node pr06-demo.mjs retry-exhausted
```

trace：

```
run:start
turn:start
error [provider/server_error] "server error 500"
retry phase=attempt attempt=2/3 delayMs=10
error [provider/server_error] "server error 500"
retry phase=attempt attempt=3/3 delayMs=20
error [provider/server_error] "server error 500"
retry phase=exhausted attempt=3/3 delayMs=0
run:end exitCode=1
```

**看什么：**

- 3 条 `error` 事件 + 2 条 `retry phase=attempt` + 1 条 `retry
  phase=exhausted`。
- `delayMs` 的增长：第 2 次尝试 delayMs=10（10 × 2^0），第 3 次尝试
  delayMs=20（10 × 2^1）——指数退避，每多一次重试延迟翻倍。因为
  `jitter=false`，这里没有随机抖动。
- `exhausted` 的 `delayMs=0`，表示"不会再等了"——这是 terminal event。
- `exitCode=1`：retry 耗尽是唯一会把 exitCode 设为 1 的错误路径。对
  比一下不可重试错误的 exitCode=0 —— harness 区分"provider 告诉我
  不行"和"我试了几次都没成功"。

### Walkthrough: 重试期间取消

```bash
node pr06-demo.mjs cancel-backoff
```

trace：

```
run:start
turn:start
error [provider/server_error] "server error"
retry phase=attempt attempt=2/3 delayMs=5000
run:cancelled reason=external
run:end exitCode=130
```

**看什么：**

- `delayMs=5000` 说明 agent 打算等 5 秒再重试。
- 但 30 ms 后外部 `AbortController` 调了 `abort()`，退避 `setTimeout`
  被 `delayWithAbort` 里注册的 abort listener `clearTimeout` 并 reject
  掉。cancel **比下一次重试更优先**。
- `run:cancelled reason=external` 出现后就不再尝试重试了。`exitCode=130`。
- 如果用 `--timeout`（走内部超时），`reason` 会是 `timeout` 而不是
  `external`——逻辑和 PR05 完全一样，只是 abort 发生在 backoff sleep
  期间。

### 试一下

1. **观察 jitter 效果：** 把 `pr06-demo.mjs` 里的 `FAST` 定义改成
   `jitter: true`，然后多跑几次 `retry-exhausted`。`delayMs` 每次都不一样
   （范围在 [0, computedDelay] 内随机）。再改回 `jitter: false`，延迟
   变成确定性的。
2. **maxAttempts=1 的行为：** 把 `FAST` 的 `maxAttempts` 改成 `1`，跑
   `retry-success`。agent 只试一次，`error` 事件后直接收尾 —— 没有
   `retry` 事件也没有 `exhausted`。因为 `attempt < maxAttempts` 永远
   不成立（attempt=1, maxAttempts=1）。
3. **看 agent-loop 的 retry 循环：** `packages/runtime/src/agent-loop.ts`
   中 `for (let attempt = 1; attempt <= maxAttempts; attempt++)` 这段
   就是所有重试逻辑的入口 —— 对照 `packages/runtime/src/retry.ts` 里
   的 `computeDelay` 和 `delayWithAbort` 理解 delayMs 怎么算出来、怎么
   被 abort。

### 更新后的附录 A — 事件类型速查

PR06 新增和修改的事件：

| 事件               | 引入的 PR     | 含义                                                            |
| ------------------ | ------------- | --------------------------------------------------------------- |
| `error`            | PR01 / PR06 改 | PR06 起增加了可选字段 `errorType`（`provider\|tool\|harness`）和 `errorCategory`（具体分类字符串），方便消费者按分类路由 |
| `retry`            | PR06          | 重试生命周期：`phase=attempt` 表示即将发起第 N 次尝试（带 `delayMs` 退避延迟），`phase=exhausted` 表示所有尝试都失败了（`delayMs=0`） |

原有的 `error` 事件仍然向后兼容 —— 不带 `errorType`/`errorCategory` 的旧
event 依然合法。

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

# Helm 手动走查 (PR15)

## PR15 — Subagent Run Tree

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

无需 API Key。

### 新增/修改文件一览

```
packages/core/src/
├── events.ts                  # run:start +parentRunId, +subagent:spawn, +subagent:complete

packages/runtime/src/
├── subagent-runtime.ts        # 新：SubagentRuntime + createSubagentTool（~230 行）
├── subagent-runtime.test.ts   # 新：9 个测试
├── agent-loop.ts              # AgentLoopOptions +parentRunId, run:start 含 parentRunId

packages/cli/
├── bin/run.ts                 # +--subagent, --subagent-script, --subagent-max-depth
├── bin/run.test.ts            # +5 个 subagent 集成测试
└── fixtures/
    ├── script-subagent.jsonl       # 新：父 agent 调 spawn_subagent
    ├── script-subagent-child.jsonl # 新：子 agent 的脚本响应
    ├── tools-subagent.json         # 新：含 read 工具
    └── perms-subagent.json         # 新：含 spawn_subagent 权限
```

### Walkthrough 1: 父 agent spawn 子 agent 去读文件

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools-subagent.json \
  packages/cli/fixtures/script-subagent.jsonl \
  packages/cli/fixtures/perms-subagent.json \
  walk-subagent \
  --subagent \
  --subagent-script=packages/cli/fixtures/script-subagent-child.jsonl
```

**终端输出：**

```
==================================================
Helm CLI — runId: walk-subagent
Tools: 3, Script: 2, Perms: 4, Mode: interactive, subagent, maxDepth=3
Journal: /tmp/helm-walk-subagent.jsonl
==================================================

🚀 [08:41:51] RUN START    id=walk-subagent
🔄 [08:41:51] TURN 0 START
🔧 [08:41:51] TOOL CALL    spawn_subagent({"task":"Read the config file and report back.","tools":["read"]})
✅ [08:41:51] PERM ALLOW   spawn_subagent
📤 [08:41:51] TOOL RESULT  {"exitCode":0,"summary":"Subagent walk-subagent-s1 completed...","events":[]}
🔄 [08:41:51] TURN 1 START
✅ [08:41:51] RUN END      exitCode=0

EXIT: 0
```

**看什么：**

- 父 agent 在 Turn 0 调 `spawn_subagent`，传 `task` 和 `tools: ["read"]`（限制子 agent 只能用 read）。
- `PERM ALLOW spawn_subagent` — 权限检查通过。
- `TOOL RESULT` 返回结构化 JSON：`exitCode: 0`，`summary` 含子 agent 完成状态和可用工具列表。
- 父拿结果后继续 Turn 1，正常退出。

---

### Walkthrough 2: Journal 里看父子 runId 关联

```bash
cat /tmp/helm-walk-subagent.jsonl
```

**核心事件（节选，按时间顺序）：**

```jsonl
{"type":"run:start","runId":"walk-subagent","parentRunId":null,"timestamp":...}
{"type":"tool:call","runId":"walk-subagent","turnIndex":0,"toolName":"spawn_subagent","args":{"task":"Read the config file and report back.","tools":["read"]},"timestamp":...}
{"type":"permission:allowed","runId":"walk-subagent","turnIndex":0,"toolName":"spawn_subagent","timestamp":...}

{"type":"subagent:spawn","runId":"walk-subagent","childRunId":"walk-subagent-s1","task":"Read the config file and report back.","timestamp":...}

{"type":"run:start","runId":"walk-subagent-s1","parentRunId":"walk-subagent","timestamp":...}
{"type":"turn:start","runId":"walk-subagent-s1","turnIndex":0,"timestamp":...}
{"type":"tool:call","runId":"walk-subagent-s1","turnIndex":0,"toolName":"read","args":{"filePath":"/tmp/helm-test-file.txt"},"timestamp":...}
{"type":"permission:allowed","runId":"walk-subagent-s1","turnIndex":0,"toolName":"read","timestamp":...}
{"type":"tool:result","runId":"walk-subagent-s1","turnIndex":0,"toolName":"read","output":"[\"filePath=/tmp/helm-test-file.txt\"]","timestamp":...}
{"type":"run:end","runId":"walk-subagent-s1","timestamp":...,"exitCode":0}

{"type":"subagent:complete","runId":"walk-subagent-s1","parentRunId":"walk-subagent","exitCode":0,"summary":"Subagent walk-subagent-s1 completed: exitCode=0\n  - Tools available: read","timestamp":...}

{"type":"tool:result","runId":"walk-subagent","turnIndex":0,"toolName":"spawn_subagent","output":"{\"exitCode\":0,...}","timestamp":...}
{"type":"run:end","runId":"walk-subagent","timestamp":...,"exitCode":0}
```

**看什么：**

- **`parentRunId` 字段：** 父 `run:start` → `parentRunId: null`。子 `run:start` → `parentRunId: "walk-subagent"`。
- **`subagent:spawn`：** `runId` 是父的 ID，`childRunId` 是子的 ID（父 ID + `-s1` 后缀），`task` 是传入的任务。
- **`subagent:complete`：** `runId` 是子的 ID，`parentRunId` 是父的 ID，含 `exitCode` + `summary`。
- 全部事件在同一个 `.jsonl` 文件里按时间戳交织。通过 `parentRunId` 可以重建完整 run tree：
  ```
  walk-subagent (null)
    └── walk-subagent-s1 (walk-subagent)
  ```

---

### Walkthrough 3: 父被取消 → 子也收到取消

子 agent 通过 `AgentLoopOptions.signal` 继承父的 `AbortSignal`：

```typescript
// subagent-runtime.ts
const childLoop = new AgentLoop(provider, childToolRuntime, childJournal, {
  signal: this.opts.signal,  // ← 父的 AbortSignal
  parentRunId,
});
```

当父收到 `Ctrl+C` 时：`sigintController.abort()` → signal propagate 到子 → 子 AgentLoop turn loop 检测 `isAborted()` → break → journal `run:cancelled`，reason 一致。

**验证：** 用长脚本 + `--subagent` 跑，中途 `Ctrl+C`，看 journal 里父子都有 `run:cancelled`。

---

### Walkthrough 4: Depth limit 保护

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools-subagent.json \
  packages/cli/fixtures/script-subagent.jsonl \
  packages/cli/fixtures/perms-subagent.json \
  walk-depth \
  --subagent \
  --subagent-script=packages/cli/fixtures/script-subagent-child.jsonl \
  --subagent-max-depth=1
```

`currentDepth >= maxDepth` 时直接返回错误，不尝试 spawn：

```json
{"exitCode":1,"summary":"Error: subagent spawn refused — max depth 1 reached (current depth: 1)"}
```

父 agent 收到这个 JSON 作为 tool result，不崩溃——只是一条错误信息，父可以继续工作。

---

### Architecture

```
AgentLoop (parent)
  │  turn:start → provider.send() → asst with tool_call(spawn_subagent)
  │  toolRuntime.execute("spawn_subagent", args)
  ▼
createSubagentTool.execute()
  │  subagentRuntime.spawn(task, parentRunId, currentDepth, toolWhitelist)
  ▼
SubagentRuntime.spawn()
  │  ✓ depth check (currentDepth >= maxDepth → refuse)
  │  ✓ create child Journal (same file)
  │  ✓ build child ToolRuntime (inherit all or whitelist)
  │  ✓ journal: subagent:spawn
  │  ✓ AgentLoop(child) with parentRunId + parent AbortSignal
  │  ✓ childLoop.run(task)
  │  ✓ journal: subagent:complete
  │  ✓ return { exitCode, summary }
  ▼
Parent AgentLoop
  │  tool:result = JSON.stringify(subagentResult)
  │  (next turn)
```

**关键设计决策：**

1. **SubagentRuntime 是独立模块。** 不硬编在 ToolRuntime 或 AgentLoop 里。`createSubagentTool()` 是工厂。
2. **单 journal 文件。** 所有 agent 写同一个 `.jsonl`。通过 `parentRunId` 重建 run tree。
3. **Tools 通过 ToolRuntime 继承。** 子可全继承或用 `tools` 参数白名单。工具对象本身被复用。
4. **Cancellation 通过 AbortSignal 传播。** 子接受父的 signal，AgentLoop 已有的 `isAborted()` 在每轮 turn 生效。
5. **Depth limit。** 默认 3，在 `SubagentRuntime` 构造函数设置。

### 事件类型速查 (PR15)

| 事件 | 新增/修改 | 字段 |
| ---- | --------- | --- |
| `run:start` | 修改 | +`parentRunId?: string \| null` |
| `subagent:spawn` | 新增 | runId(父), childRunId, task |
| `subagent:complete` | 新增 | runId(子), parentRunId, exitCode, summary |

### Java 类比

| 概念 | Java 世界 |
| ---- | --------- |
| SubagentRuntime | `@Service class SubagentOrchestrator` |
| spawn() | `CompletableFuture<SubagentResult> spawn(task, parentId, depth)` |
| Tool inheritance | `childToolRuntime = parentToolRuntime.restrict(allowedNames)` |
| parentRunId | OpenTelemetry `traceId` / `spanId` |
| Cancellation propagation | `CancellationTokenSource` linked tokens |

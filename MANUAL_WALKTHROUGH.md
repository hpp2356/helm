# Helm 手动走查 (PR13)

## PR13 — CLI Non-Interactive Mode

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

无需 API Key。所有场景用 ScriptedProvider 驱动，不依赖真实 LLM。

### 新增/修改文件一览

```
packages/core/src/
├── permission.ts              # +PermissionPolicy, PermissionCheckOptions, riskAtOrBelow()
├── tool.ts                    # +riskLevel 可选字段
├── events.ts                  # +permission:allowed, permission:denied 事件
└── index.ts                   # 导出新类型

packages/runtime/src/
├── permission-runtime.ts      # check() 接受可选 PermissionCheckOptions
├── permission-runtime.test.ts # +9 个 policy 测试
├── tool-runtime.ts            # +PermissionPolicy, checkPermission() 公开方法
├── agent-loop.ts              # +permission 事件 journal, +permissionDenied 跟踪
├── agent-loop.test.ts         # +5 个 permission 集成测试
├── bash-tool.ts               # +riskLevel: CRITICAL
├── file-tools.ts              # +riskLevel 到所有 5 个文件工具

packages/cli/
├── bin/run.ts                 # +--non-interactive, --risk-threshold flag 解析
├── bin/run.test.ts            # 重写，14 个测试覆盖所有模式
└── fixtures/
    ├── tools.json             # +riskLevel
    ├── tools-risked.json      # 新：含 LOW/CRITICAL 风险等级
    ├── script-mixed.jsonl     # 新：同时调用 LOW + CRITICAL 工具
    └── perms-empty.json       # 新：空权限列表
```

### Walkthrough 1: Baseline — 不加 flag 的正常交互行为

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walk-baseline
```

输出：

```
==================================================
Helm CLI — runId: walk-baseline
Tools: 2, Script: 2, Perms: 2, Mode: interactive
Journal: /tmp/helm-walk-baseline.jsonl
==================================================

🚀 [03:32:15] RUN START    id=walk-baseline
🔄 [03:32:15] TURN 0 START
🔧 [03:32:15] TOOL CALL    calculator({"expression":"2+3"})
✅ [03:32:15] PERM ALLOW   calculator
📤 [03:32:15] TOOL RESULT  ["expression=2+3"]
🔄 [03:32:15] TURN 1 START
✅ [03:32:15] RUN END      exitCode=0

Done. Journal → /tmp/helm-walk-baseline.jsonl
```

**看什么：**

- `Mode: interactive` — 不加 flag 时默认行为不变（backward-compatible）。
- `PERM ALLOW` — calculator 在 `perms.json` 的 allowlist 中，权限检查通过。
- `exitCode=0` — 正常退出。
- `EXIT: 0` — `echo $?` 返回 0。

---

### Walkthrough 2: `--non-interactive=auto-approve` — 所有工具自动通过

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms-empty.json \
  walk-auto-approve \
  --non-interactive=auto-approve
```

**终端输出：**

```
==================================================
Helm CLI — runId: walk-auto-approve
Tools: 2, Script: 2, Perms: 0, Mode: non-interactive (auto-approve)
Journal: /tmp/helm-walk-auto-approve.jsonl
==================================================

🚀 [03:32:19] RUN START    id=walk-auto-approve
🔄 [03:32:19] TURN 0 START
🔧 [03:32:19] TOOL CALL    calculator({"expression":"2+3"})
✅ [03:32:19] PERM ALLOW   calculator
📤 [03:32:19] TOOL RESULT  ["expression=2+3"]
🔄 [03:32:19] TURN 1 START
✅ [03:32:19] RUN END      exitCode=0

Done. Journal → /tmp/helm-walk-auto-approve.jsonl
EXIT: 0
```

**Journal (`/tmp/helm-walk-auto-approve.jsonl`)：**

```jsonl
{"type":"run:start","runId":"walk-auto-approve","timestamp":1780889539167}
{"type":"turn:start","runId":"walk-auto-approve","turnIndex":0,"timestamp":1780889539168}
{"type":"tool:call","runId":"walk-auto-approve","turnIndex":0,"toolName":"calculator","args":{"expression":"2+3"},"timestamp":1780889539169}
{"type":"permission:allowed","runId":"walk-auto-approve","turnIndex":0,"toolName":"calculator","timestamp":1780889539169}
{"type":"tool:result","runId":"walk-auto-approve","turnIndex":0,"toolName":"calculator","output":"[\"expression=2+3\"]","timestamp":1780889539169}
{"type":"turn:start","runId":"walk-auto-approve","turnIndex":1,"timestamp":1780889539169}
{"type":"run:end","runId":"walk-auto-approve","timestamp":1780889539169,"exitCode":0}
```

**看什么：**

- `Perms: 0` — 空权限文件，没有 allowlist/denylist 规则。但因为 `auto-approve` 策略，所有工具自动通过。
- `permission:allowed` 事件出现在 journal 中——AgentLoop 在 execute 之前先做权限检查并记录。
- `exitCode=0` — 没有被拒的权限，正常退出。

---

### Walkthrough 3: `--non-interactive=auto-deny` — 工具被拒 + exit code 2

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms-empty.json \
  walk-auto-deny \
  --non-interactive=auto-deny
```

**终端输出：**

```
==================================================
Helm CLI — runId: walk-auto-deny
Tools: 2, Script: 2, Perms: 0, Mode: non-interactive (auto-deny)
Journal: /tmp/helm-walk-auto-deny.jsonl
==================================================

🚀 [03:32:19] RUN START    id=walk-auto-deny
🔄 [03:32:19] TURN 0 START
🔧 [03:32:19] TOOL CALL    calculator({"expression":"2+3"})
⛔ [03:32:19] PERM DENY    calculator — Tool "calculator" auto-denied (non-interactive: auto-deny)
⛔ [03:32:19] TOOL RESULT  Error: permission denied — Tool "calculator" auto-denied (non-interactive: auto-...
🔄 [03:32:19] TURN 1 START
✅ [03:32:19] RUN END      exitCode=0

Done. Journal → /tmp/helm-walk-auto-deny.jsonl
EXIT: 2
```

**Journal (`/tmp/helm-walk-auto-deny.jsonl`)：**

```jsonl
{"type":"run:start","runId":"walk-auto-deny","timestamp":1780889539875}
{"type":"turn:start","runId":"walk-auto-deny","turnIndex":0,"timestamp":1780889539876}
{"type":"tool:call","runId":"walk-auto-deny","turnIndex":0,"toolName":"calculator","args":{"expression":"2+3"},"timestamp":1780889539876}
{"type":"permission:denied","runId":"walk-auto-deny","turnIndex":0,"toolName":"calculator","reason":"Tool \"calculator\" auto-denied (non-interactive: auto-deny)","timestamp":1780889539876}
{"type":"tool:result","runId":"walk-auto-deny","turnIndex":0,"toolName":"calculator","output":"Error: permission denied — Tool \"calculator\" auto-denied (non-interactive: auto-deny)","timestamp":1780889539876}
{"type":"turn:start","runId":"walk-auto-deny","turnIndex":1,"timestamp":1780889539877}
{"type":"run:end","runId":"walk-auto-deny","timestamp":1780889539877,"exitCode":0}
```

**看什么：**

- `⛔ PERM DENY` — 所有工具被 auto-deny 策略拒绝。
- `permission:denied` 事件在 journal 中，包含 `reason` 字段说明原因。
- Agent 收到 error 后进入下一轮 turn，没有工具可调就直接结束——**不 hang**。
- `EXIT: 2` — `process.exit(2)` 表示有权限被拒。区别于 exit 0（成功）和 exit 1（fatal error）。

---

### Walkthrough 4: Risk-Threshold — LOW 过了，CRITICAL 被拒

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools-risked.json \
  packages/cli/fixtures/script-mixed.jsonl \
  packages/cli/fixtures/perms-empty.json \
  walk-risk-threshold \
  --non-interactive=risk-threshold \
  --risk-threshold=MEDIUM
```

**终端输出：**

```
==================================================
Helm CLI — runId: walk-risk-threshold
Tools: 3, Script: 2, Perms: 0, Mode: non-interactive (risk-threshold, threshold=MEDIUM)
Journal: /tmp/helm-walk-risk-threshold.jsonl
==================================================

🚀 [03:32:20] RUN START    id=walk-risk-threshold
🔄 [03:32:20] TURN 0 START
🔧 [03:32:20] TOOL CALL    calculator({"expression":"2+3"})
✅ [03:32:20] PERM ALLOW   calculator
📤 [03:32:20] TOOL RESULT  ["expression=2+3"]
🔧 [03:32:20] TOOL CALL    danger({"target":"/etc"})
⛔ [03:32:20] PERM DENY    danger — Tool "danger" auto-denied (risk CRITICAL exceeds threshold MEDIUM)
⛔ [03:32:20] TOOL RESULT  Error: permission denied — Tool "danger" auto-denied (risk CRITICAL exceeds thre...
🔄 [03:32:20] TURN 1 START
✅ [03:32:20] RUN END      exitCode=0

Done. Journal → /tmp/helm-walk-risk-threshold.jsonl
EXIT: 2
```

**Journal (`/tmp/helm-walk-risk-threshold.jsonl`)：**

```jsonl
{"type":"run:start","runId":"walk-risk-threshold","timestamp":1780889540672}
{"type":"turn:start","runId":"walk-risk-threshold","turnIndex":0,"timestamp":1780889540673}
{"type":"tool:call","runId":"walk-risk-threshold","turnIndex":0,"toolName":"calculator","args":{"expression":"2+3"},"timestamp":1780889540673}
{"type":"permission:allowed","runId":"walk-risk-threshold","turnIndex":0,"toolName":"calculator","timestamp":1780889540673}
{"type":"tool:result","runId":"walk-risk-threshold","turnIndex":0,"toolName":"calculator","output":"[\"expression=2+3\"]","timestamp":1780889540674}
{"type":"tool:call","runId":"walk-risk-threshold","turnIndex":0,"toolName":"danger","args":{"target":"/etc"},"timestamp":1780889540674}
{"type":"permission:denied","runId":"walk-risk-threshold","turnIndex":0,"toolName":"danger","reason":"Tool \"danger\" auto-denied (risk CRITICAL exceeds threshold MEDIUM)","timestamp":1780889540674}
{"type":"tool:result","runId":"walk-risk-threshold","turnIndex":0,"toolName":"danger","output":"Error: permission denied — Tool \"danger\" auto-denied (risk CRITICAL exceeds threshold MEDIUM)","timestamp":1780889540674}
{"type":"turn:start","runId":"walk-risk-threshold","turnIndex":1,"timestamp":1780889540674}
{"type":"run:end","runId":"walk-risk-threshold","timestamp":1780889540674,"exitCode":0}
```

**看什么：**

- **同一轮 turn 内两种结果：**
  - `calculator` (riskLevel: LOW) ≤ MEDIUM threshold → `permission:allowed` → 工具正常执行。
  - `danger` (riskLevel: CRITICAL) > MEDIUM threshold → `permission:denied` → 工具被拒。
- Journal 中同一个 `turnIndex: 0` 下，既有 `permission:allowed` 又有 `permission:denied`。
- Deny reason 明确写了 `risk CRITICAL exceeds threshold MEDIUM`。
- `EXIT: 2` — 因为至少有一个 permission denied。

---

### Architecture

```
CLI (run.ts)
  │  parse --non-interactive=<strategy>
  │  parse --risk-threshold=<level>
  │  create PermissionPolicy
  ▼
ToolRuntime(permissionRuntime, permissionPolicy)
  │  checkPermission() → PermissionRuntime.check(name, args, opts)
  │    opts: { toolRiskLevel, policy }
  ▼
PermissionRuntime.check()
  ├─ deny rule match?  → DENY (deny-first, policy can't override)
  ├─ allow rule match? → ALLOW
  └─ no rule match → consult policy:
       ├─ auto-approve    → ALLOW
       ├─ auto-deny       → DENY
       └─ risk-threshold  → ALLOW if toolRisk ≤ threshold, else DENY
  │
  ▼
AgentLoop
  ├─ journal permission:allowed / permission:denied
  ├─ skip tool execution on deny
  └─ track permissionDenied flag
  │
  ▼
CLI
  └─ permissionDenied? → process.exit(2)
```

**关键设计决策：**

1. **Policy 是 fallback，不是 override。** 显式 deny 规则始终生效（deny-first），显式 allow 规则也始终生效。Policy 只在无规则匹配时介入。这保证了 `--non-interactive=auto-approve` 不会绕过显式 deny。
2. **RiskLevel 在 Tool 上定义。** 每个 Tool 有可选的 `riskLevel` 字段，ToolRuntime 在执行时传递给 PermissionRuntime。未知 risk level 的工具被视为 CRITICAL（保守默认）。
3. **AgentLoop 负责 journal 权限事件。** `checkPermission()` 是 ToolRuntime 的公开方法，AgentLoop 在 execute 之前调用它来记录决策。权限检查本身仍然在 PermissionRuntime 中完成（决策源不变，只是从 human 变 policy）。
4. **Exit code 2 表示权限被拒。** 区别于 exit 0（成功）和 exit 1（fatal error），便于 CI/脚本判断。

### 事件类型速查 (PR13 新增)

| 事件                  | 来源       | 说明                                       |
| --------------------- | ---------- | ------------------------------------------ |
| `permission:allowed`  | AgentLoop  | 权限检查通过（每 tool call 一次）            |
| `permission:denied`   | AgentLoop  | 权限被拒，含 reason 字段                    |

已有事件不变：`run:start`, `turn:start`, `tool:call`, `tool:result`, `error`, `retry`, `run:cancelled`, `run:end`。

### CLI Flag 速查

| Flag | 值 | 说明 |
| ---- | --- | --- |
| `--non-interactive` | `auto-approve` | 无匹配规则时自动允许 |
| `--non-interactive` | `auto-deny` | 无匹配规则时自动拒绝 |
| `--non-interactive` | `risk-threshold` | 基于风险等级阈值决策 |
| `--risk-threshold` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | 配合 risk-threshold 使用，默认 MEDIUM |

### Java 类比

| 概念                     | Java 世界                                    |
| ------------------------ | -------------------------------------------- |
| PermissionPolicy         | `enum NonInteractiveMode { AUTO_APPROVE, AUTO_DENY, RISK_THRESHOLD }` |
| riskAtOrBelow()          | `RiskLevel.compareTo(threshold) <= 0`         |
| PermissionCheckOptions   | `record CheckOpts(RiskLevel toolRisk, Policy policy) {}` |
| checkPermission()        | `public Optional<Decision> checkPermission(...)` |
| permission:allowed event | Journal DTO `PermissionAllowedEvent`           |
| EXIT_PERMISSION_DENIED   | `public static final int EXIT_PERM_DENIED = 2;` |

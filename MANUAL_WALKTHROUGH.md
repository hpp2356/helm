# Helm 手动走查 (PR16)

## PR16 — CLI Interactive Mode (REPL)

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

无需 API Key。REPL 默认使用 ScriptedProvider。

### 新增/修改文件一览

```
packages/core/src/
├── (无修改)

packages/runtime/src/
├── agent-loop.ts              # run() 支持 continueFrom + 返回 messages
├── index.ts                   # 导出 MessageRecord, AgentLoopResult
└── agent-loop.test.ts         # (向后兼容，无修改)

packages/cli/
├── bin/run.ts                 # +subcommand dispatch (run|repl|bare)
├── bin/run.test.ts            # +12 REPL 测试
├── src/repl.ts                # 新：REPL 模块 (~250 行)
├── package.json               # +optionalDep: @helm/provider-deepseek
└── tsconfig.json              # +include: src/**, +ref: provider-deepseek
```

### Walkthrough 1: 启动 REPL → 输入 → 看到回复

```bash
echo -e "Hello, agent!\n/exit" | node packages/cli/dist/bin/run.js repl --provider=scripted
```

**输出：**

```
╭─────────────────────────────────────────────────────╮
│                   Helm REPL                          │
│  Type your message and press Enter to send.          │
│  /help    — Show available commands                  │
│  /clear   — Clear conversation history               │
│  /exit    — Exit REPL                                │
│  /stats   — Show session stats                       │
╰─────────────────────────────────────────────────────╯

Provider: scripted
Journal: /tmp/helm-repl-xxxxx.jsonl
Tools: read, write, edit, ls, glob

> Goodbye.
Journal → /tmp/helm-repl-xxxxx.jsonl
```

**看什么：**

- 欢迎 banner 显示 REPL 模式、provider 名、可用工具列表。
- `/exit` 退出，exit code 0。
- Journal 写到 `/tmp/helm-repl-*.jsonl`。

---

### Walkthrough 2: Tool call 显示

```bash
echo -e "Read the config file.\n/exit" | node packages/cli/dist/bin/run.js repl --provider=scripted --tools=packages/cli/fixtures/tools.json --perms=packages/cli/fixtures/perms.json
```

**输出（截取 tool call 部分）：**

```
  🔧 calculator({"expression":"2+3"})
  📤 ["expression=2+3"]
```

**看什么：**

- `🔧` 前缀显示 tool call 名称和参数。
- `📤` 前缀显示 tool result（截断到 80 字符）。
- REPL 的 journal interceptor 在 tool 执行时实时打印。

---

### Walkthrough 3: `/clear` 清空历史再对话

```bash
echo -e "First message.\n/clear\nSecond message.\n/exit" | node packages/cli/dist/bin/run.js repl --provider=scripted
```

**输出：**

```
> ✔ Conversation history cleared.
>
```

**看什么：**

- `/clear` 后 `messageHistory` 重置为空数组。
- 后续对话从干净的上下文开始。

---

### Walkthrough 4: Ctrl-C 中断 turn 后继续

手动测试（需要 TTY）：

```bash
node packages/cli/dist/bin/run.js repl --provider=scripted
```

1. 输入一段话，Enter。
2. 在 turn 执行期间按 Ctrl-C。
3. 看到 `⚠ Interrupting...`。
4. 继续输入下一句 —— REPL 不退出。

**机制：** 每个 turn 创建独立的 `AbortController` + 临时 SIGINT handler。turn 结束后恢复原 handler。

---

### Walkthrough 5: 长会话触发 compaction（PR14 回归）

```bash
echo -e "msg0\nmsg1\nmsg2\nmsg3\nmsg4\nmsg5\n/exit" | node packages/cli/dist/bin/run.js repl --provider=scripted --compaction=truncate --token-budget=400 --tools=packages/cli/fixtures/tools.json --perms=packages/cli/fixtures/perms.json
```

**输出（当 token 累积到 warning threshold）：**

```
  🗜️  Compaction: msgs 15→6
```

---

### Walkthrough 6: `/exit` 退出，检查 journal 完整性

```bash
cat /tmp/helm-repl-*.jsonl | python3 -c "
import sys, json
events = [json.loads(l) for l in sys.stdin if l.strip()]
types = set(e['type'] for e in events)
print('Event types:', sorted(types))
"
```

**输出：**

```
Event types: ['run:end', 'run:start', 'tool:call', 'tool:result', 'turn:start']
```

**看什么：**

- Journal 包含完整的 `run:start` ... `run:end` 生命周期。
- 多轮对话的 turn 交错记录在同一个文件里。

---

### Architecture

```
helm repl [flags]
  └─ run.ts: parseReplArgs() → build provider → startRepl(config)
       │
       └─ repl.ts:
            ├─ PermissionRuntime + ToolRuntime (same as batch)
            ├─ Optional Compaction + TokenBudget
            ├─ Journal interceptor (compact REPL display)
            ├─ readline.createInterface (stdin/stdout)
            ├─ State: messageHistory[], turnCount
            └─ Input loop:
                 ├─ /command → handle (exit/clear/help/stats/mode)
                 └─ user message → AgentLoop.run(runId, msg, history)
                      │
                      ├─ AgentLoop sends to Provider
                      ├─ Tool calls → journal interceptor prints
                      └─ Returns {messages} → update history
```

**关键设计决策：**

1. **AgentLoop 改动最小。** 仅加 `continueFrom` 参数和返回 `messages`。AgentLoop 仍然是唯一的 turn 执行者。
2. **REPL 管理消息历史。** 每次用户输入创建一个新 AgentLoop run，传入累积的 `messageHistory`。run 结束后更新历史。
3. **Provider 由调用者构建。** repl.ts 接受已构建的 Provider 实例，不依赖 `@helm/provider-deepseek`。run.ts 负责 provider 创建（含动态 import）。
4. **node:readline 零依赖。** 不引入第三方 readline 库。Ctrl-C 通过临时 SIGINT handler + AbortController 处理。
5. **Journal 单文件。** 所有 REPL turn 写同一个 `.jsonl`。每轮 run 有独立的 `runId`（`repl-xxxxx-t1`, `repl-xxxxx-t2`）。

### CLI Flag 速查 (PR16 新增)

| Flag | 值 | 说明 |
| ---- | --- | --- |
| `--provider` | `scripted`, `deepseek` | Provider 类型（默认 scripted） |
| `--model` | `<name>` | 模型名（deepseek 时用） |
| `--api-key` | `<key>` | API key（也可用 env） |
| `--tools` | `<path>` | 工具 JSON 文件 |
| `--perms` | `<path>` | 权限 JSON 文件 |
| `--workspace` | `<path>` | workspace 根目录 |
| `--max-turns` | `<n>` | 每轮最大 turn 数（默认 20） |

### Java 类比

| 概念 | Java 世界 |
| ---- | --------- |
| REPL loop | `while (true) { String line = reader.readLine(); ... }` |
| messageHistory | `List<Message> conversationHistory` |
| AgentLoop.run(continueFrom) | `agentLoop.run(userMessage, history)` |
| Ctrl-C per turn | `try { ... } catch (InterruptedException e) { ... }` |
| readline | `java.io.Console` / JLine |
| Journal interceptor | SLF4J MDC / event listener |

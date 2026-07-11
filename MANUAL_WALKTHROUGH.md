# Helm 手动走查 (PR20)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试
pnpm -C packages/core test       # 只看 streaming 测试
pnpm -C packages/provider-deepseek test  # 只看 provider 测试
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## 场景 1：对话 → 看 streaming 逐 token 输出（text_delta）

**命令**：

```bash
pnpm repl --provider=deepseek
> Tell me a short joke
```

**预期行为**：

- REPL 不再等全部完成再显示，而是**逐 token 流式输出**
- 每收到一个 SSE `text_delta`，立即 `process.stdout.write(text)` 打到终端
- turn 结束后显示统计行：`↳ N tokens, M tool calls, X.Xs`

**对比**（streaming vs non-streaming）：

| 模式 | 输出方式 | 用户感知 |
|------|----------|----------|
| Streaming（PR20） | 逐 token 实时打印 | 文字像打字一样出现 |
| Non-streaming（PR19） | 缓冲到完成再整体显示 | 等待 → 突然全部出现 |

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | tail -5
```

```json
{"type":"assistant:text","runId":"repl-xxx-t1","turnIndex":1,"content":"Why did the scarecrow win an award? Because he was outstanding in his field!","timestamp":...}
```

> 注意：journal 记录的是完整文本（不是逐 delta），streaming 事件不写入 journal。

## 场景 2：Agent 调 tool → 看 tool_call_delta 事件

**命令**：

```bash
pnpm repl --provider=deepseek
> Read the file package.json and tell me the version
```

**预期行为**：

1. REPL 实时输出文本 delta（"Let me read..."）
2. Provider 收到 `tool_calls` SSE chunk 时，emit `tool_call_delta` 事件
3. Journal 拦截器显示 tool call 和 result（与 PR19 一致）
4. turn 结束后显示统计：`↳ N tokens, 1 tool calls, X.Xs`

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | grep -E "tool:call|tool:result"
```

```json
{"type":"tool:call","runId":"repl-xxx-t1","turnIndex":1,"toolName":"read","args":{"path":"package.json"},"timestamp":...}
{"type":"tool:result","runId":"repl-xxx-t1","turnIndex":1,"toolName":"read","output":"...","timestamp":...}
```

## 场景 3：/stats 查看 streaming 统计

**命令**：

```bash
pnpm repl --provider=deepseek
> Hello, how are you?
> /stats
```

**预期输出**：

```
Session stats:
  Messages: 3
  Turns:    1
  Provider: deepseek-v4-flash
  Journal:  /tmp/helm-repl-xxx.jsonl

Streaming stats:
  Text tokens:      42
  Tool call deltas: 0
  Thinking tokens:  0
```

> `Text tokens` 是字符数代理（不是真正的 tokenizer），反映 streaming 接收的总字符数。

## 场景 4：non-streaming provider 不受影响

**命令**：

```bash
pnpm repl --provider=scripted
> Hello
```

**预期行为**：

- ScriptedProvider 没有 streaming，不 emit 任何 StreamingEvent
- REPL 回退到 PR19 行为：缓冲完成后再显示 assistant card
- `/stats` 不显示 "Streaming stats" 段落（因为 `streamingBus` 为空）

## 场景 5：多轮对话 → stats 累积

**命令**：

```bash
pnpm repl --provider=deepseek
> What is 1+1?
> What is 2+2?
> /stats
```

**预期输出**：

```
Session stats:
  Messages: 5
  Turns:    2
  Provider: deepseek-v4-flash
  Journal:  /tmp/helm-repl-xxx.jsonl

Streaming stats:
  Text tokens:      85
  Tool call deltas: 0
  Thinking tokens:  0
```

> stats 跨 turn 累积，直到 REPL 退出或 `resetStats()` 被调用。

## StreamingBus 执行流程

```
用户输入 "Hello"
  │
  ├─ repl.ts processInput()
  │     ├─ streamedTextThisTurn = false
  │     ├─ streamingBus.emit({ type: "turn_start", turnIndex: 1 })
  │     ├─ loop.run(runId, "Hello", messageHistory)
  │     │     ├─ provider.send(messages, signal)
  │     │     │     ├─ SSE chunk { delta: { content: "Hi" } }
  │     │     │     │     ├─ onText("Hi")              ← PR16 callback（仍可用）
  │     │     │     │     └─ bus.emit({ type: "text_delta", text: "Hi" })
  │     │     │     │           └─ REPL subscriber: process.stdout.write("Hi")
  │     │     │     │           └─ streamedTextThisTurn = true
  │     │     │     ├─ SSE chunk { delta: { content: " there!" } }
  │     │     │     │     └─ bus.emit({ type: "text_delta", text: " there!" })
  │     │     │     └─ return { role: "assistant", content: "Hi there!" }
  │     │     └─ return result
  │     ├─ streamingBus.emit({ type: "turn_end", turnIndex: 1 })
  │     ├─ streamedTextThisTurn === true
  │     │     └─ 跳过 renderAssistantCard（不重复打印）
  │     │     └─ 显示统计行: ↳ 8 tokens, 0 tool calls, 1.2s
  │     └─ journal 拦截器: assistant:text → 跳过打印（streaming 已打印）
  │           └─ 仍然调 originalAppend(event) 写入 journal
```

## IDEA 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/core/src/streaming.ts` | `emit()` | 每个 StreamingEvent 的类型和内容 |
| `packages/core/src/streaming.ts` | `updateStats()` | stats 累积逻辑 |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | `this._streamingBus?.emit()` | SSE delta → StreamingEvent 转换 |
| `packages/cli/src/repl.ts` | `streamingBus.on()` subscriber | REPL 实时输出逻辑 |
| `packages/cli/src/repl.ts` | `streamedTextThisTurn` 检查 | 跳过重复打印的判断 |
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`、`this.toolRuntime.list()` |

## 改动文件

```
packages/core/src/
├── streaming.ts              StreamingEvent 类型 + StreamingBus + StreamingStats
├── streaming.test.ts         StreamingBus 测试（11 个）
└── index.ts                  导出 streaming 类型

packages/provider-deepseek/src/
└── openai-compatible-provider.ts   新增 streamingBus 选项 + emit 调用
    openai-compatible-provider.test.ts  新增 6 个 streaming bus 测试

packages/cli/src/
└── repl.ts                   创建 bus、订阅、实时输出、跳过重复打印

packages/cli/bin/
└── run.ts                    创建 StreamingBus、传给 provider 和 REPL

packages/skill/src/
└── builtins.ts               /stats 显示 streaming 统计
```

## 关键设计决策

1. **StreamingBus 同步 emit** — handler 内联执行，REPL 无需 buffering
2. **Provider 接口不变** — streaming 是 `OpenAICompatibleProvider` 的内部实现，通过 `streamingBus` 选项注入
3. **REPL 创建 bus** — `run.ts` 创建 bus，传给 provider 和 `startRepl()`
4. **不重复打印** — `streamedTextThisTurn` 标记避免 streaming + assistant card 双重输出
5. **stats 累积** — StreamingBus 自己收集统计，`/stats` 读取显示
6. **thinking_delta** — 支持 DeepSeek 的 `reasoning_content` 字段
7. **turn_start/turn_end** — REPL 在 turn 生命周期边界 emit，未来可用于回放
8. **向后兼容** — 不传 `streamingBus` 时行为与 PR19 完全一致

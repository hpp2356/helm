# Helm 手动走查 (PR14)

## PR14 — Smart Compaction

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

无需 API Key。所有场景用 ScriptedProvider 驱动。

### 新增/修改文件一览

```
packages/core/src/
├── events.ts                  # +compaction 事件类型
packages/runtime/src/
├── compaction.ts              # 新：Compaction 模块（~330 行）
├── compaction.test.ts         # 新：12 个测试
├── agent-loop.ts              # +compaction 集成（触发、journal、budget 重置）
├── agent-loop.test.ts         # +5 个 compaction 集成测试
└── index.ts                   # 导出 Compaction 及类型
packages/cli/
├── bin/run.ts                 # +--compaction, --compaction-keep-turns, --token-budget flags
└── fixtures/
    ├── script-long.jsonl      # 新：长脚本（8 个 response）
    └── script-compaction.jsonl
```

### Walkthrough 1: Baseline — 短会话不触发压缩

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

🚀 [08:05:06] RUN START    id=walk-baseline
🔄 [08:05:06] TURN 0 START
🔧 [08:05:06] TOOL CALL    calculator({"expression":"2+3"})
✅ [08:05:06] PERM ALLOW   calculator
📤 [08:05:06] TOOL RESULT  ["expression=2+3"]
🔄 [08:05:06] TURN 1 START
✅ [08:05:06] RUN END      exitCode=0
```

**看什么：**

- 未传 `--compaction` 时行为不变（backward-compatible）。
- 短会话跑完，无 compaction 事件。

---

### Walkthrough 2: 长会话触发压缩 — truncate 策略

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script-long.jsonl \
  packages/cli/fixtures/perms.json \
  walk-truncate \
  --compaction=truncate \
  --token-budget=1000
```

**终端输出（截取关键部分）：**

```
==================================================
Helm CLI — runId: walk-truncate
Tools: 2, Script: 8, Perms: 2, Mode: interactive, compaction=truncate, keep=2, budget=1000
Journal: /tmp/helm-walk-truncate.jsonl
==================================================

🚀 [08:04:56] RUN START    id=walk-truncate
🔄 [08:04:56] TURN 0 START
🔧 [08:04:56] TOOL CALL    calculator({"expression":"1+1"})
✅ [08:04:56] PERM ALLOW   calculator
📤 [08:04:56] TOOL RESULT  ["expression=1+1"]

  ... (turns 1-6: more calculator + weather calls) ...

🔄 [08:04:56] TURN 7 START
🗜️  [08:04:56] COMPACTION    strategy=truncate msgs 15→6 tokens 186→116
✅ [08:04:56] RUN END      exitCode=0

EXIT: 0
```

**Journal（compaction 事件）：**

```jsonl
{"type":"compaction","runId":"walk-truncate","turnIndex":7,"strategy":"truncate","messageCountBefore":15,"messageCountAfter":6,"tokensEstimatedBefore":186,"tokensEstimatedAfter":116,"timestamp":1780905896380}
```

**看什么：**

- 7 个 turn 正常执行，每个 tool call 都有对应的 `PERM ALLOW` + `TOOL RESULT`。
- Turn 7 开始时 `TokenBudget.isWarning()` 返回 true → 触发 compaction。
- **compaction event：** `msgs 15→6`（消息减少 60%），`tokens 186→116`（token 减少 38%）。
- Agent 继续工作，正常结束（exitCode 0）。
- `strategy: truncate` — 旧 turn 被截断，最近 2 turn 保留。

---

### Walkthrough 3: 压缩后 agent 继续工作

```bash
grep 'tool:call' /tmp/helm-walk-truncate.jsonl
```

输出：

```
{"type":"tool:call","runId":"walk-truncate","turnIndex":0,"toolName":"calculator","args":{"expression":"1+1"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":1,"toolName":"weather","args":{"city":"a"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":2,"toolName":"calculator","args":{"expression":"2+2"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":3,"toolName":"weather","args":{"city":"b"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":4,"toolName":"calculator","args":{"expression":"3+3"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":5,"toolName":"weather","args":{"city":"c"},...}
{"type":"tool:call","runId":"walk-truncate","turnIndex":6,"toolName":"calculator","args":{"expression":"4+4"},...}
```

**看什么：**

- 7 个 tool call 全部正常执行 — compaction 在 turn 7 trigger 但不中断 agent。
- 每个 tool:call 都有对应的 tool:result（journal 里 tool:result 紧随其后）。
- Compaction 后 agent 拿到 compacted context 继续调用 provider.send()。

---

### Walkthrough 4: `--compaction=summarize` — LLM 生成摘要

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script-long.jsonl \
  packages/cli/fixtures/perms.json \
  walk-summarize \
  --compaction=summarize \
  --token-budget=1000
```

**终端输出：**

```
==================================================
Helm CLI — runId: walk-summarize
Tools: 2, Script: 8, Perms: 2, Mode: interactive, compaction=summarize, keep=2, budget=1000
Journal: /tmp/helm-walk-summarize.jsonl
==================================================

🚀 [08:14:29] RUN START    id=walk-summarize
🔄 [08:14:29] TURN 0 START
🔧 [08:14:29] TOOL CALL    calculator({"expression":"1+1"})
✅ [08:14:29] PERM ALLOW   calculator
📤 [08:14:29] TOOL RESULT  ["expression=1+1"]

  ... (turns 1-6: same as truncate walkthrough) ...

🔄 [08:14:29] TURN 7 START
🗜️  [08:14:29] COMPACTION    strategy=summarize msgs 15→6 tokens 186→142
✅ [08:14:29] RUN END      exitCode=0

EXIT: 0
```

**Journal（compaction 事件）：**

```json
{
    "type": "compaction",
    "runId": "walk-summarize",
    "turnIndex": 7,
    "strategy": "summarize",
    "messageCountBefore": 15,
    "messageCountAfter": 6,
    "tokensEstimatedBefore": 186,
    "tokensEstimatedAfter": 142,
    "summaryText": "[Compaction summary] Previous conversation covered tool calls and their results. The agent completed several tasks successfully."
}
```

**和 truncate 的区别：**

| 维度 | truncate | summarize |
|------|----------|-----------|
| LLM 调用 | 无 | 有（Provider.send） |
| 压缩后 token | 116 | 142（摘要比 truncation note 长） |
| summaryText | 无 | 有，LLM 生成的摘要 |
| 消息内容 | `[Earlier conversation truncated...]` | `[Previous conversation summary]\n<摘要>` |
| 适用场景 | 快速、确定、无 LLM 依赖 | 保留语义信息，更长的未来 turn 需要上下文 |

**debug 要点：**

- `strategy: summarize` — 确认用的 LLM 策略而非 truncate。
- `summaryText` 非空 — 确认 LLM 返回了摘要内容。如果摘要只有 `[Compacted N messages...]` 说明 LLM 调用失败，触发了 fallback。
- `messageCountAfter` 仍为 6 — 和 truncate 一样只保留 user + summary + 2 recent turns（4 msg）。
- 生产环境替换 provider：CLI 里 `compactionProvider` 换成真实 `OpenAICompatibleProvider` 即可用 DeepSeek/OpenAI 生成摘要。

---

### Walkthrough 5: 压缩保留 turn 完整性

truncate 策略压缩后的消息列表结构：

```typescript
// Before compaction (5 turns, ~11 messages):
// [user, asst(T0,toolCalls), tool(T0), asst(T1,toolCalls), tool(T1),
//  asst(T2,toolCalls), tool(T2), asst(T3,toolCalls), tool(T3),
//  asst(T4,toolCalls), tool(T4)]

// After truncation (keepRecentTurns=2):
// [user, "[Earlier conversation truncated — 2 recent turns kept.]",
//  asst(T3,toolCalls), tool(T3), asst(T4,toolCalls), tool(T4)]
```

**看什么：**

- Turn 边界对齐：每个 turn（asst + its tool results）作为整体被保留或压缩。
- 不会出现 tool result 在 compacted 区但 asst message 在 recent 区的情况。
- 初始 user message 始终保留。
- System prompt + tool defs 不在消息列表中（通过 ContextBuilder 单独传递），不受压缩影响。

---

### Architecture

```
AgentLoop.run()
  │
  ├─ turn:start
  ├─ Budget check
  │    ├─ tokenBudget.isWarning() && !wasCompacted?
  │    │    YES → Compaction.compact(messages, tools, signal)
  │    │    │
  │    │    ├─ splitIntoTurns(messages)
  │    │    ├─ Keep: user msg + last N turns
  │    │    ├─ Compress: middle turns
  │    │    │    ├─ "summarize" → Provider.send(summaryPrompt)
  │    │    │    └─ "truncate" → drop middle, insert note
  │    │    ├─ journal: compaction event
  │    │    └─ tokenBudget.reset()
  │    │
  │    └─ window.estimatedTokens > remaining?
  │         YES → EXHAUSTED
  │         NO  → consume(window.estimatedTokens)
  │
  ├─ Provider.send(messages, signal)
  ├─ Tool execution
  └─ (loop)
```

**关键设计决策：**

1. **Compaction 是独立模块（`compaction.ts`）。** AgentLoop 组合它，不硬编码压缩逻辑。
2. **Turn 边界对齐。** `splitIntoTurns()` 按 assistant message 分组 tool call/result，确保要么全保留要么全压缩。
3. **Compaction 只触发一次。** `wasCompacted` 标记防止重复压缩。Budget 重置给 agent 新空间。
4. **Budget 跟踪准确。** 压缩前估原始 context；压缩后 reset + re-consume compacted context。
5. **Summarize fallback。** summarize 策略失败时自动降级为 truncate，不崩溃。
6. **System prompt + tool defs 不受压缩影响。** 通过 ContextBuilder 单独传递。

### CLI Flag 速查

| Flag | 值 | 说明 |
| ---- | --- | --- |
| `--compaction` | `truncate` | 删除旧 turn，保留最近 N turn |
| `--compaction` | `summarize` | 用 Provider 生成摘要替换旧 turn |
| `--compaction-keep-turns` | `<n>` | 保留最近 N 个 turn（默认 2） |
| `--token-budget` | `<n>` | token budget 上限（默认 4096） |

### 事件类型速查 (PR14 新增)

| 事件 | 来源 | 说明 |
| ---- | ---- | --- |
| `compaction` | AgentLoop | strategy, messageCountBefore/After, tokensEstimatedBefore/After, summaryText? |

### Java 类比

| 概念 | Java 世界 |
| ---- | --------- |
| Compaction class | `@Component class MessageCompactor` |
| splitIntoTurns() | `MessageHistory.groupByTurnBoundaries()` |
| CompactionStrategy | `enum Strategy { SUMMARIZE, TRUNCATE }` |
| Provider.send for summary | `llmProvider.call(summarizePrompt)` |
| wasCompacted flag | `private boolean alreadyCompacted` |
| TokenBudget.reset() | `budget.resetConsumed(packedContextTokens)` |
| compaction journal event | `JournalEvent.builder().type("compaction")...` |

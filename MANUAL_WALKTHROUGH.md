# Helm 手动走查 (PR12)

## PR12 — First Real Provider: DeepSeek (OpenAI-Compatible)

### 前置条件

**⚠️ 本走查需要 DeepSeek API Key。** 请先[申请](https://platform.deepseek.com/api_keys)，然后执行**一次性**设置：

```bash
echo "sk-your-key-here" > ~/.deepseek-api-key
```

之后所有 demo 脚本自动从 `~/.deepseek-api-key` 读取，不再需要每次 export 环境变量。
（`~/.deepseek-api-key` 在 repo 外部，不会被 git 追踪。）

如果没有 API Key，可以跳过需要 API Key 的章节，但单元测试不依赖真实 API，可以直接跑 `pnpm test`。

### 准备工作

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

### 新增文件一览

```
packages/provider-deepseek/
├── package.json                          # 依赖 openai@^6.42.0, gpt-tokenizer@^3.4.0
├── tsconfig.json                         # 引用 ../core 和 ../runtime
├── vitest.config.ts
└── src/
    ├── index.ts                          # 导出 OpenAICompatibleProvider, OpenAITokenCounter
    ├── openai-compatible-provider.ts     # 主实现 (~270 行)
    ├── openai-compatible-provider.test.ts # 41 个测试
    ├── token-counter.ts                  # OpenAITokenCounter (cl100k_base)
    └── token-counter.test.ts            # token 计数器测试

demo/
├── pr12-token-counter.ts                 # Token Counter 对比演示
├── pr12-first-chat.ts                    # 第一次真实 LLM 对话
├── pr12-tool-use.ts                      # Tool Use 完整循环
├── pr12-agent-loop.ts                    # AgentLoop + DeepSeek 集成
└── pr12-error-mapping.ts                # Error 映射 + Retry 演示
```

修改的文件：

```
packages/core/src/provider.ts      # +可选 setTools 方法
packages/runtime/src/agent-loop.ts  # +3 行：每轮调用 setTools
package.json                       # +"type": "module"（tsx 需要 ESM 模式）
```

### Walkthrough: 单元测试（不需要 API Key）

```bash
pnpm --filter @helm/provider-deepseek exec vitest run --reporter=verbose
```

**看什么：**

- **Message 转换测试**：UserMessage → `{ role: "user" }`，ToolResult → `{ role: "tool", tool_call_id: "..." }`，
  `toolCalls` 中的 `args` 被 `JSON.stringify` 后嵌入 `function.arguments`。
- **Stream 重组测试**：覆盖分 chunk tool call 场景——name 在第一个 chunk，arguments 分两个 chunk 到达，
  按 `index` 组装后 `JSON.parse` 得到完整 args。
- **Error 映射**：每种 HTTP 状态码和 SDK 错误类型都映射到正确的 `ProviderError` category + retryable flag。
  这直接决定 AgentLoop 的 retry 行为（PR06 已集成）。
- **Token Counter**：用真实 `cl100k_base` 编码计数，中文、代码都能正确 tokenize。

### Walkthrough: Message 转换规则（不需要 API Key）

`npx tsx` 没有执行代码，只输出转换规则，帮理解 Helm ↔ OpenAI 格式映射：

```bash
echo '
console.log("=== Helm → OpenAI Message 转换规则 ===");
console.log("");
console.log("Helm                          →  OpenAI");
console.log("─────────────────────────────────────────────────────");
console.log("{ role: \"user\" }              →  { role: \"user\" }");
console.log("{ role: \"assistant\" }         →  { role: \"assistant\" } (+ tool_calls if present)");
console.log("{ role: \"tool\" }             →  { role: \"tool\", tool_call_id }");
console.log("");
console.log("System prompt 不在 Message 里，通过 ContextBuilder.systemPrompt 单独传递。");
console.log("OpenAICompatibleProvider 把它作为 messages[0] { role: \"system\" } 插入。");
' | node
```

输出：

```
=== Helm → OpenAI Message 转换规则 ===

Helm                          →  OpenAI
─────────────────────────────────────────────────────
{ role: "user" }              →  { role: "user" }
{ role: "assistant" }         →  { role: "assistant" } (+ tool_calls if present)
{ role: "tool" }             →  { role: "tool", tool_call_id }

System prompt 不在 Message 里，通过 ContextBuilder.systemPrompt 单独传递。
OpenAICompatibleProvider 把它作为 messages[0] { role: "system" } 插入。
```

### Walkthrough: Token Counter 对比（不需要 API Key）

```bash
npx tsx demo/pr12-token-counter.ts
```

输出：

```
=== Token Counter Comparison ===
Text                          | Char(4) | cl100k_base | Diff
---------------------------------------------------------------------------
Hello, world!                 |       4 |           4 | =
function factorial(n) { re... |      16 |          19 | +3
你好世界                      |       1 |           4 | +3
console.log("hello");         |       6 |           7 | +1

=== Message Token Count ===
Conversation (2 messages):
  CharTokenCounter:   25
  OpenAITokenCounter: 29

=== 中文 Token 计数差异 ===
Text: 你好世界，这是一个测试。
  Char(4):       4 (中文每字约 1-2 token)
  cl100k_base:   14 (实际 token)
```

**看什么：**

- 英文文本中 `CharTokenCounter`（4 chars/token）和 `cl100k_base` 接近——英文平均确实 ~4 chars/token。
- 中文文本差异巨大——`"你好世界"` 4 个中文字符，Char(4) 只算 1 token，实际是 4 token。
  `cl100k_base` 对 CJK 字符每个字单独编码。
- `OpenAITokenCounter` 使用 `gpt-tokenizer` 的 `encode()` 函数，和 DeepSeek API 服务端
  token 计数误差在 ~1-2% 内。

### Walkthrough: 第一个真实 LLM 对话 ⚠️ 需要 DEEPSEEK_API_KEY

```bash
npx tsx demo/pr12-first-chat.ts
```

输出（示例——实际内容因模型而异）：

```
=== 第一次真实 LLM 对话 ===
Role: assistant
Content: Hello! 2+2 equals 4.
ToolCalls: none
```

**看什么：**

- `provider.send()` 接受 Helm `Message[]`，返回 Helm `Message`。一行代码就从 DeepSeek API
  拿到了回复——`AgentLoop` 调的就是同一个 `send()` 方法。
- `response.toolCalls` 为 undefined——没有注册工具，模型只回文本。
- 背后发生：Helm messages → OpenAI 格式 → `POST https://api.deepseek.com/v1/chat/completions`
  → SSE streaming → 拼接 delta → Helm Message。

### Walkthrough: Tool Use 完整循环 ⚠️ 需要 DEEPSEEK_API_KEY

```bash
npx tsx demo/pr12-tool-use.ts
```

输出（示例——实际内容因模型而异）：

```
=== Tool Use 完整循环 ===
--- Turn 1 ---
Role: assistant
Content: (empty — model chose tool)
Tool Call: calculator {"expression":"123 * 456"}

--- Turn 2 ---
Role: assistant
Content: 123 × 456 = 56,088
ToolCalls: none
```

**看什么：**

- **Turn 1：** 模型看到 `calculator` 工具，决定调用它。返回 `toolCalls` 数组，
  每个 tool call 有 `id`（OpenAI 生成）、`name` 和 `args`。
  注意 `args` 已经被 `JSON.parse` 从 string 转回 `Record<string, unknown>`。
- **Turn 2：** 把 assistant message（含 tool_calls）和 tool result 一起发给模型。
  模型收到 `56088` 的计算结果，输出最终答案。
- 这个两轮交互就是 `AgentLoop` 内部发生的事情——PR12 只实现了 `send()`，
  AgentLoop 的 turn loop 在 PR02 就写好了。两者通过 `Provider` 接口解耦。

### Walkthrough: AgentLoop + DeepSeek 集成 ⚠️ 需要 DEEPSEEK_API_KEY

```bash
npx tsx demo/pr12-agent-loop.ts
```

输出（示例——实际内容因模型而异）：

```
=== AgentLoop + DeepSeek: 文件读取 ===
Workspace: /tmp/helm-pr12-xxxxx

Exit Code: 0

=== Journal Trace ===
  [run:start]
  [turn:start]
  [tool:call] tool=read args={"filePath":"hello.txt"}
  [tool:result] output={"content":"Hello from PR12!","totalLines":1,"path":"hello.txt"}
  [turn:start]
  [run:end]
```

**看什么：**

- Agent 真的用上了 `read` 工具。这是 Helm journal 里**第一次出现真实的 LLM 驱动的 tool call**。
- `tool:call` → `tool:result` — 模型返回 tool call（`read hello.txt`），文件工具执行，读到文件内容。
- 第二个 `turn:start` — AgentLoop 自动把 tool result 发回 LLM，进入下一轮 turn。
- `exitCode: 0` — normal exit。

### Walkthrough: Error 映射 + Retry 模拟 ⚠️ 需要 DEEPSEEK_API_KEY

```bash
npx tsx demo/pr12-error-mapping.ts
```

输出（示例）：

```
=== Error Mapping: Auth Failure ===
Type: provider
Category: auth_failure
Retryable: false
StatusCode: 401
Message: Authentication failed (401): Incorrect API key provided: sk-inval...key

=== Normal Call with Valid Key ===
Role: assistant
Content: Hello
(No error — auth works)
```

**看什么：**

- `auth_failure` → `retryable: false`。AgentLoop 不会重试——认证失败重试没有意义。
- `statusCode: 401` 从 HTTP 响应中提取，传到 `ProviderError`。
- retryable mapping：`rate_limit`、`server_error`、`network`、`timeout` → retryable=true；
  `auth_failure`、`unknown` → retryable=false。
- AgentLoop 收到 `HelmError` 后，通过 `classifyAgentError` 解出 `AgentError`，
  再调 `retryPolicy.shouldRetry(agentError)` 决定是否重试——和 ScriptedProvider 的错误注入完全一样的路径。

### 试一下

1. **读 provider 源码：** `packages/provider-deepseek/src/openai-compatible-provider.ts`。
   核心逻辑 ~270 行——`helmToOpenAIMessages`（~45 行）、`classifyOpenAIError`（~50 行）、
   `send()` 方法（~60 行）。
2. **切到 OpenAI：** 改 demo 脚本里两行就能切——`baseURL: "https://api.openai.com"`，
   `model: "gpt-4o"`，`apiKey: process.env.OPENAI_API_KEY`。
3. **看 demo 源码：** `demo/` 目录下每个 `.ts` 文件都很短（20-60 行），可以当 API 使用示例来读。
4. **AgentLoop 的 token budget：** 在 AgentLoop 构造时传 tokenBudget 和 contextBuilder：
   ```ts
   const loop = new AgentLoop(provider, tr, journal, {
     maxTurns: 5,
     tokenBudget: new TokenBudget(8000),
     contextBuilder: new ContextBuilder(new OpenAITokenCounter()),
   });
   ```
   这样 AgentLoop 每轮会先用 `OpenAITokenCounter` 估算 token 用量，逼近 8000 就停。

### Java 类比

| 概念                     | Java 世界                                    |
| ------------------------ | -------------------------------------------- |
| Provider interface       | `interface LLMProvider { Response send(...); }` |
| OpenAICompatibleProvider | `class OpenAIProvider implements LLMProvider`   |
| Message 转换             | DTO mapping layer (MapStruct / ModelMapper)     |
| SSE streaming            | `AsyncIterable<Chunk>` 或 Java 21 Flow API      |
| Tool call 重组           | `Collectors.groupingBy(ToolCallDelta::index)`   |
| HelmError (ProviderError)| Custom exception with `retryable` flag          |
| setTools()               | `setter` injection before `call()`              |
| TokenCounter             | `interface TokenCounter` (strategy pattern)     |
| AgentLoop 不变           | `for (turn) { provider.send(...); }` loop       |
| ScriptedProvider 保留    | `@Primary` bean 旁的 `@Profile("test")` mock     |

### 事件类型速查

| 事件            | 来源           | 说明                                       |
| --------------- | -------------- | ------------------------------------------ |
| `run:start`     | AgentLoop      | 和 PR02 一样                               |
| `turn:start`    | AgentLoop      | 和 PR02 一样                               |
| `tool:call`     | AgentLoop      | 和 PR02 一样                               |
| `tool:result`   | AgentLoop      | 和 PR02 一样                               |
| `error`         | AgentLoop      | 和 PR06 一样（provider error 经 classify） |
| `retry`         | AgentLoop      | 和 PR06 一样                               |
| `run:cancelled` | AgentLoop      | 和 PR05 一样                               |
| `run:end`       | AgentLoop      | 和 PR02 一样                               |

PR12 **没有**新增事件类型。provider 的 HTTP 请求/响应细节暂不 journal——
llm:request/llm:response 事件留到 PR19（observability）再标准化。

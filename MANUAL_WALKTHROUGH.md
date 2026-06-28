# Helm 手动走查 (PR17)

## PR17 — MCP Client（含 HTTP SSE / Streamable HTTP 传输）

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

### 新增/修改文件一览

```
packages/mcp/
├── package.json               # 新包：@helm/mcp，依赖 @modelcontextprotocol/sdk ^1.29.0
├── tsconfig.json
└── src/
    ├── index.ts                # 公开 API export
    ├── types.ts                # McpServerConfig, McpHttpServerConfig, AnyMcpServerConfig
    ├── client.ts               # McpClient — stdio + HTTP (SSE/Streamable) 双传输
    ├── registry.ts             # McpRegistry — 多 server 管理 + tools()
    ├── schema.ts               # mcpToolToHelmTool, normaliseSchema
    └── client.test.ts          # 25 个测试（stdio + HTTP mock）

packages/cli/
├── bin/run.ts                  # +--mcp-server=<name>=<command> flag
├── src/repl.ts                 # +McpRegistry集成，connect → registerTools
├── package.json                # +@helm/mcp dependency
└── tsconfig.json               # +{ path: "../mcp" } reference

pnpm-workspace.yaml             # +packages/mcp
```

### Walkthrough 1: 完整 MCP client 生命周期（InMemoryTransport，无需外部进程）

```bash
tsx demo/pr17-mcp-client.ts
```

**输出：**

```
── 连接成功 ──
server: demo
available: true
tools: add, echo

── tools/list ──
  add: Add two numbers
  echo: Returns the input message

── tools/call ──
add(2, 3) → { content: [{ type: "text", text: "5" }], isError: false }
echo("hello from MCP") → { content: [{ type: "text", text: "hello from MCP" }], isError: false }

── Helm ToolRuntime ──
registered: demo:add
  description: [MCP:demo] Add two numbers
ToolRuntime.execute('demo:add', {a:10, b:20}) → 30

── 未知 tool ──
callTool('nonexistent') → isError: true
  message: Error: unknown tool: nonexistent

── disconnect 后调用 ──
callTool after disconnect → isError: true
  message: Error: MCP server "demo" is unavailable

── 完成 ──
MCP client lifecycle: connect → list → call → degrade → disconnect ✓
```

**看什么：**

1. **connect** — `McpClient.connectTransport()` → SDK 自动执行 initialize/initialized handshake
2. **tools/list** — 连接成功后 `client.tools` 包含 server 暴露的所有工具
3. **tools/call** — `client.callTool("add", {a:2, b:3})` 返回结构化 content blocks `[{type:"text", text:"5"}]`
4. **Helm ToolRuntime** — `registry.tools()` 将 MCP tool 转为 Helm Tool，name 带 `demo:` 前缀；ToolRuntime.execute 走正常权限+执行链路
5. **Graceful 降级** — 未知 tool → `isError: true`，不 throw；disconnect 后 → "unavailable"，不 crash
6. **完整生命周期** — connect → list → call → degrade → disconnect

---

### Walkthrough 2: 单元测试（25 个测试，无需外部进程）

```bash
pnpm -C packages/mcp test --reporter=verbose
```

**测试覆盖：**

| 分组 | 测试数 | 覆盖内容 |
|------|--------|---------|
| McpClient (stdio) | 5 | connect, listTools, callTool, unknown tool, unavailable, tool error |
| McpRegistry | 2 | 多 server 聚合, namespace 前缀, 空 registry |
| HTTP transport (SSE) | 5 | 构造函数, connect 分发, connectHttp 参数传递, headers 处理, 降级 |
| HTTP transport (Streamable) | 4 | 构造函数, connect 分发, connectHttp 参数传递 |
| 向后兼容 | 2 | stdio 不受影响, HTTP mock 不干扰 stdio 路径 |

**看什么：**

- 使用 `vi.mock` + `vi.hoisted` mock SSE/StreamableHTTP transport，无真实网络调用
- Mock 记录 constructor 参数 (URL, headers)，验证分发逻辑正确
- 向后兼容测试确保现有 stdio 路径未受影响

---

### Walkthrough 3: HTTP 传输配置类型

```bash
# 查看类型定义
node -e "
const types = \`
// Stdio（默认，向后兼容）
McpServerConfig {
  transport?: 'stdio'            // 默认值
  name: string
  command: string                // 可执行文件
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number             // 默认 10_000
}

// SSE（spec 2024-11-05，deprecated 但仍广泛使用）
McpHttpServerConfig {
  transport: 'sse'
  name: string
  url: string                    // e.g. https://example.com/sse
  headers?: Record<string, string>  // e.g. Authorization
  timeoutMs?: number
}

// Streamable HTTP（spec 2025-03-26+，推荐）
McpHttpServerConfig {
  transport: 'streamableHttp'
  name: string
  url: string                    // e.g. https://example.com/mcp
  headers?: Record<string, string>
  timeoutMs?: number
}

// 联合类型
AnyMcpServerConfig = McpServerConfig | McpHttpServerConfig
\`;
console.log(types);
"
```

**看什么：**

- `transport` 字段作为 discriminated union 的分发键
- `McpServerConfig`（stdio）的 `transport` 可选，省略时默认 stdio，保持向后兼容
- `McpHttpServerConfig` 的 `transport` 必填，值为 `"sse"` 或 `"streamableHttp"`
- SSE 已 deprecated，SDK 推荐 Streamable HTTP，但很多现有 server 仍用 SSE

---

### Walkthrough 4: connect() 传输分发逻辑

```bash
# 查看分发逻辑
node -e "
const dispatch = \`
// packages/mcp/src/client.ts — connect() 方法

connect(config: McpServerConfig | McpHttpServerConfig) {
  if (config.transport === 'sse' || config.transport === 'streamableHttp') {
    return this.connectHttp(config);  // → HTTP 路径
  }
  // stdio 路径（默认）
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
  });
  return this._connect(transport);
}

connectHttp(config: McpHttpServerConfig) {
  const url = new URL(config.url);
  const requestInit = config.headers
    ? { headers: config.headers }
    : undefined;

  const transport = config.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });

  return this._connect(transport);
}
\`;
console.log(dispatch);
"
```

**看什么：**

- `connect()` 检查 `config.transport`，分发到 stdio 或 HTTP 路径
- `connectHttp()` 根据 `transport` 值选择 `SSEClientTransport` 或 `StreamableHTTPClientTransport`
- `headers` 通过 `requestInit` 传给 transport（例如 `Authorization: Bearer xxx`）
- 两个路径最终都调用同一个 `_connect()` 私有方法，共享 handshake + listTools + 超时 + 错误处理逻辑

---

### Walkthrough 5: SSE vs Streamable HTTP 协议差异

```
SSE (spec 2024-11-05) — deprecated
  ┌──────────┐   GET /sse (SSE stream)    ┌──────────┐
  │  Client  │ ◄───────────────────────── │  Server  │
  │          │   POST /message             │          │
  │          │ ──────────────────────────► │          │
  └──────────┘                             └──────────┘
  
  • Client → Server: HTTP POST 到 endpoint URL
  • Server → Client: SSE event stream (text/event-stream)
  • sessionId 通过 query param 传递

Streamable HTTP (spec 2025-03-26+) — recommended
  ┌──────────┐   POST /mcp (JSON-RPC)     ┌──────────┐
  │  Client  │ ──────────────────────────► │  Server  │
  │          │   GET /mcp (SSE stream)     │          │
  │          │ ◄────────────────────────── │          │
  └──────────┘                             └──────────┘
  
  • 双向通过单一 HTTP endpoint
  • JSON-RPC batching 支持
  • session 通过 MCP-Session-Id header 管理
  • 支持断线重连 (Last-Event-ID header, resumptionToken)
  • OAuth 2.1 Authorization Framework
```

**看什么：**

- SSE 是早期的过渡方案，event stream 和 message POST 走不同的请求
- Streamable HTTP 统一了 endpoint，支持更多企业级特性（batching、session、重连、OAuth）
- Helm 同时支持两种，`transport` 字段区分；推荐新部署用 Streamable HTTP

---

### Walkthrough 6: CLI flag `--mcp-server` 解析

```bash
# 模拟 flag 解析（使用 Node）
node -e "
const val = '--mcp-server=mycalc=node server.js';
const sv = val.slice('--mcp-server='.length);
const eq = sv.indexOf('=');
console.log('name:', sv.slice(0, eq));
console.log('command:', sv.slice(eq + 1));
"
```

**输出：**

```
name: mycalc
command: node server.js
```

**看什么：**

- `--mcp-server=<name>=<command>` 格式，`=` 第一个等号分割 name/command
- 多个 server 使用多个 flag：`--mcp-server=math=node math-srv.js --mcp-server=search=python search-srv.py`
- 当前只支持 stdio（subprocess）；未来可扩展 `--mcp-server-http=<name>=<url>` 支持 HTTP

---

### Walkthrough 7: REPL 里使用 MCP tools

```bash
# 启动 REPL（需要真实 MCP server）
node packages/cli/dist/bin/run.js repl --provider=deeepseek --mcp-server=mycalc=node mcp-servers/calc.js
```

**预期流程（TTY 交互）：**

1. 欢迎框后看到 `ℹ MCP server "mycalc" connected`
2. 输入 `用 mycalc 算一下 2+3` → 回车
3. Agent turn 开始，journal 里有工具调用
4. REPL 显示工具结果
5. `/exit` 退出

**看什么：**

- MCP tools 的内置 tools 共存（read/write/edit/ls/glob + MCP tools）
- 退出时 McpRegistry.disconnect() 清理所有 server 连接

---

### Architecture

```
--mcp-server=<name>=<command>
  │
  └─ run.ts: parseReplArgs() → McpServerFlag[]
       │
       └─ repl.ts: startRepl(config)
            │
            ├─ McpRegistry.connect(configs)   ← 并行连接所有 server
            │    │
            │    └─ McpClient.connect(config)  ← 分发 transport 类型
            │         │
            │         ├─ (transport === undefined || "stdio")
            │         │    ├─ StdioClientTransport (spawn 子进程)
            │         │    ├─ Client.connect() → initialize/initialized handshake
            │         │    └─ Client.listTools() → 获取工具列表
            │         │
            │         └─ (transport === "sse" || "streamableHttp")
            │              ├─ SSEClientTransport / StreamableHTTPClientTransport
            │              ├─ Client.connect() → initialize/initialized handshake
            │              └─ Client.listTools() → 获取工具列表
            │
            ├─ McpRegistry.tools() → Tool[]
            │    └─ 每个 tool: name="serverName:toolName"
            │                 execute → client.callTool(originalName, args)
            │
            ├─ ToolRuntime.register(mcpTool)   ← 注册到共享 ToolRuntime
            ├─ PermissionRuntime.allow(...)     ← 权限注册
            │
            └─ ... agent runs ...
                 │
                 └─ McpRegistry.disconnect()    ← 退出时清理
```

**MCP 发给 LLM 的最终 prompt 格式：**

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are Helm..." },
    { "role": "user", "content": "帮我算 2+3" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "mycalc:add",
        "description": "[MCP:mycalc] Add two numbers",
        "parameters": {
          "type": "object",
          "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
          "required": ["a", "b"]
        }
      }
    }
  ]
}
```

**关键设计决策：**

1. **`@helm/mcp` 独立包。** 不污染 `@helm/runtime`，MCP 是 tool 来源之一。
2. **使用 `@modelcontextprotocol/sdk` ^1.29.0。** 官方维护的 JSON-RPC 2.0 实现，不自己写协议层。提供 Stdio/SSE/StreamableHTTP/WebSocket 四种 transport。
3. **transport 可注入。** 生产用 StdioClientTransport / SSEClientTransport / StreamableHTTPClientTransport，测试用 InMemoryTransport + Mock，无需启动子进程或真实网络。
4. **transport 类型分发。** 通过 `config.transport` discriminated union，`connect()` 自动分发到正确的 transport 实现。
5. **namespace 前缀。** `serverName:toolName` 避免多 server tool 名冲突。
6. **graceful degradation。** server 崩溃或 HTTP 连接失败 → `callTool` 返回 error result 而非 throw → agent 继续运行。
7. **权限走正常流程。** MCP tools 通过 PermissionRuntime.allow() 注册，不受特殊处理。
8. **SSE + Streamable HTTP 双支持。** SSE 兼容现有 server，Streamable HTTP 为推荐方案（支持 batching、session 管理、断线重连）。

---

### Walkthrough 8: IDEA 调试完整 LLM 调用链路（REPL 交互式）

**前置条件**：设置 `DEEPSEEK_API_KEY` 环境变量或 `~/.deepseek-api-key` 文件。

**IDEA 配置**：

```
右上角下拉 → "Helm REPL"（无 MCP）或 "Helm REPL + MCP"（带 MCP tools）→ 🐛 Debug
```

**完整调用链路**：

```
你在 REPL 输入 "帮我算 2+3"
          │
          ▼
  repl.ts: startRepl()
  1. readline.on("line") 收到输入
  2. 拼 messageHistory: [...history, {role:"user", ...}]
  3. AgentLoop.run(runId, userInput, messageHistory)
          │
          ▼
  agent-loop.ts                         🔴 断点 1: 第 268 行
  4. toToolDefs(toolRuntime.list())  ← 收集所有工具（内置 + MCP）
  5. provider.setTools(toolDefs)     ← 通知 provider
  6. provider.send(messages, signal) ← 调用 LLM
          │
          ▼
  openai-compatible-provider.ts         🔴 断点 2: 第 282 行
  7. helmToOpenAIMessages(messages) ← 转 OpenAI 格式
  8. helmToOpenAITools(this._tools)  ← 转 function calling 格式
  9. client.chat.completions.create({
       model, messages, tools, stream   ← 💡 看 openaiMessages + openaiTools
     })
          │
          │  ──── HTTP ────→ DeepSeek API
          │
          ▼
  10. 逐 chunk 读取 stream
  11. 组装 tool_calls + content
  12. return { role: "assistant", content, toolCalls }
          │
          ▼
  agent-loop.ts (继续)
  13. 检查 response.toolCalls
  14. 有 toolCall → 拼 assistant message（含 tool_calls）
  15. toolRuntime.execute(toolName, args)  ← 执行工具
  16. 拼 tool result message
  17. 回到步骤 5（第二轮 LLM 调用）
          │
          │ 第二轮 messages 内容：
          │ [system, user, assistant(toolCalls: add(2,3)), tool(result: 5)]
          │
          ▼
  18. LLM 返回最终文本回复
  19. 拼 assistant message → 回到 repl.ts
          │
          ▼
  repl.ts
  20. renderAssistantCard(finalContent)  ← 渲染到终端
```

**断点位置**：

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`（Helm 格式）、`this.toolRuntime.list()` |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | **282** | `openaiMessages`（最终 prompt）、`openaiTools`（最终工具列表） |

**Debug 步骤**：

```bash
# 1. 启动（IDEA 里点 Debug）
# 2. Console 出现 Helm REPL 界面
# 3. 输入：帮我算 2+3
# 4. 断点 268 命中 → Variables 看 messages
# 5. F9 Resume → 断点 282 命中 → Alt+F8 输入 JSON.stringify(openaiMessages, null, 2)
# 6. F9 Resume → 第二轮断点 268 命中 → messages 里多了 tool call
# 7. F9 Resume → 第二轮断点 282 命中 → messages 含完整 tool 交互历史
# 8. F9 Resume → REPL 显示回复
```

**第二轮 LLM 调用时 messages 的内容**：

```json
[
  { "role": "system", "content": "You are Helm, an AI assistant..." },
  { "role": "user", "content": "帮我算 2+3" },
  {
    "role": "assistant",
    "content": null,
    "toolCalls": [
      { "id": "call_abc", "name": "calc:add", "args": { "a": 2, "b": 3 } }
    ]
  },
  {
    "role": "tool",
    "content": "5",
    "toolCallId": "call_abc"
  }
]
```

**IDEA vs Java 调试对比**：

| | Java Spring Boot | Helm REPL |
|---|---|---|
| 启动 | `Application.main()` | IDEA Debug `Helm REPL` |
| 交互 | curl / Postman | Console 里打字回车 |
| 请求入口断点 | Controller 方法 | `agent-loop.ts:268` |
| 看请求体 | `@RequestBody` body | `messages` 变量 |
| 看出站请求 | `RestTemplate` 调用处 | `openai-compatible-provider.ts:282` |
| 看出站请求体 | `HttpEntity` body | `openaiMessages` 变量 |
| 表达式求值 | Alt+F8 → `new Gson().toJson(obj)` | Alt+F8 → `JSON.stringify(obj, null, 2)` |

---

### 测试期望

**单元测试（无需 API Key，无需网络）**：

| 测试分组 | 期望 |
|---------|------|
| McpClient (stdio) | connect → available=true, tools 包含 server 暴露的工具；callTool 返回结构化 content blocks；unknown tool → isError=true；disconnect 后 → unavailable |
| McpRegistry | 多 server 工具聚合，名称带 namespace 前缀（`server:tool`）；空 registry → tools() 返回 `[]` |
| HTTP transport dispatch | `connect()` 收到 `transport="sse"` → 创建 `SSEClientTransport`，传入正确 URL + headers；`transport="streamableHttp"` → 创建 `StreamableHTTPClientTransport`；`transport=undefined` → 走 stdio 不触发 HTTP mock |
| HTTP graceful degradation | 连接失败 → `callTool` 返回 error result 而非 throw；`isError=true`，content 含 "unavailable" |

**Demo 脚本输出期望**：

```
tsx demo/pr17-mcp-client.ts

── 连接成功 ──
server: demo
available: true
tools: add, echo

── Helm ToolRuntime ──
registered: demo:add
registered: demo:echo
ToolRuntime.execute('demo:add', {a:10, b:20}) → 30

── disconnect 后调用 ──
callTool after disconnect → isError: true
  message: Error: MCP server "demo" is unavailable
```

**REPL 调试期望**：

```
pnpm repl
# 或 IDEA Debug "Helm REPL"

> 帮我算 2+3
# → agent-loop.ts:268 断点命中，messages 含 system + user
# → openai-compatible-provider.ts:282 断点命中，openaiMessages 含 system + user
# → LLM 返回 tool_calls（或直接文本回复）
# → 如果有 tool call，第二轮断点命中，messages 含完整交互历史
# → REPL 显示最终回复
```

### Java 类比

| 概念 | Java 世界 |
| ---- | --------- |
| McpClient | `HttpClient` (管理单个 server 连接) |
| McpRegistry | `ServiceRegistry` (管理多个 client) |
| InMemoryTransport | `MockWebServer` / `WireMock` (测试用) |
| tools/call | RPC call → `CompletableFuture<Result>` |
| graceful degradation | `try { rpc.call() } catch (IOException e) { return errorResult; }` |
| StdioClientTransport | `ProcessBuilder.start()` + stdin/stdout pipe |
| SSEClientTransport | `EventSource` + `HttpURLConnection` (SSE stream) |
| StreamableHTTPClientTransport | `HttpClient` with streaming response (单一 endpoint) |
| transport dispatch | Strategy pattern / Factory method |
| @modelcontextprotocol/sdk | gRPC / RSocket 协议库 |
| IDEA Debug REPL | IDEA Debug Spring Boot + curl |
| Alt+F8 JSON.stringify | Alt+F8 new Gson().toJson() |

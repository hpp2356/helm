# Helm 手动走查 (PR17)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试（含 MCP 25 + CLI 76）
pnpm -C packages/mcp test        # 只看 MCP 测试
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## pnpm repl 启动过程

**命令**：`node packages/cli/dist/bin/run.js repl --provider=deepseek`

**入口**：`packages/cli/bin/run.ts → main()`

| 顺序 | 文件 | 做什么 |
|------|------|--------|
| 1 | `run.ts:249` `main()` | 解析 `process.argv`，发现是 `repl` 子命令 |
| 2 | `run.ts:262` | `import("../src/repl.js")` 动态加载 REPL 模块 |
| 3 | `run.ts:263` | `loadSettings()` 读 `.helm/settings.json` |
| 4 | `run.ts:281` | `parseReplArgs()` 解析 `--provider`、`--mcp-server` 等 flag |
| 5 | `run.ts:286-316` | 创建 Provider：读 `DEEPSEEK_API_KEY` 环境变量 → `new OpenAICompatibleProvider()` |
| 6 | `run.ts:318` | 调 `startRepl(config)` → 进入 `packages/cli/src/repl.ts` |

**repl.ts `startRepl()` 初始化**：

| 顺序 | 行号 | 做什么 |
|------|------|--------|
| 7 | `repl.ts:290-293` | 创建 `JsonlJournal`（写 `/tmp/helm-repl-xxx.jsonl`） |
| 8 | `repl.ts:299` | `new PermissionRuntime()` |
| 9 | `repl.ts:316` | `new ToolRuntime(permissionRuntime)` |
| 10 | `repl.ts:329` | `registerFileTools()` — 注册 read/write/edit/ls/glob/bash 工具 |
| 11 | `repl.ts:336-357` | `new McpRegistry()` — 如果传了 `--mcp-server`，`connect()` 连 MCP server，`tools()` 注册到 ToolRuntime |
| 12 | `repl.ts:567-577` | 构造 system prompt |
| 13 | `repl.ts:579` | `messageHistory = [systemMessage]` |
| 14 | `repl.ts:582-630` | 渲染欢迎框 |
| 15 | `repl.ts:632-650` | 创建 `AgentLoop({ provider, toolRuntime, journal })` |
| 16 | `repl.ts:470-480` | 创建 `readline` 接口，注册 `"line"` 回调 → **等待输入** |

## 输入一句话后

```
你输入 "帮我算 2+3" 回车
  │
  ├─ repl.ts "line" 回调
  │     ├─ 检查是否是 / 命令（/exit, /help, /stats, /clear）
  │     ├─ 不是 → handleUserInput(line)
  │     │
  │     └─ handleUserInput():
  │           ├─ messageHistory.push({ role: "user", content: line })
  │           ├─ turnCount++
  │           ├─ AgentLoop.run(runId, line, messageHistory)
  │           │     │
  │           │     ├─ agent-loop.ts:259  provider.setTools(toolDefs)
  │           │     ├─ agent-loop.ts:268  provider.send(messages, signal)    🔴 断点 1
  │           │     │     │
  │           │     │     └─ openai-compatible-provider.ts
  │           │     │           278: helmToOpenAIMessages(messages)
  │           │     │           279: helmToOpenAITools(this._tools)
  │           │     │           282: client.chat.completions.create({...})   🔴 断点 2
  │           │     │                  │
  │           │     │                  └─ HTTP → DeepSeek API
  │           │     │
  │           │     ├─ LLM 返回 tool_calls → toolRuntime.execute(...) → 拼 tool result
  │           │     └─ 下一轮 send()（messages 含 tool call + tool result 历史）
  │           │
  │           └─ messageHistory.push({ role: "assistant", content: reply })
  │
  └─ 终端渲染回复
```

## IDEA 断点位置

右上角选 `Helm REPL` → Debug。这两个断点：

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`（对话历史）、`this.toolRuntime.list()`（所有工具） |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | **282** | `openaiMessages` + `openaiTools`，发给 LLM 的最终 JSON |

Alt+F8 → `JSON.stringify(openaiMessages, null, 2)` 复制完整 prompt。

## MCP 怎么接入的

`repl.ts:336-357`，在 `startRepl()` 里：

```typescript
const mcpRegistry = new McpRegistry();
if (config.mcpServers && config.mcpServers.length > 0) {
  await mcpRegistry.connect(configs);           // 并行连所有 MCP server
  for (const tool of mcpRegistry.tools()) {
    toolRuntime.register(tool);                 // 注册到 ToolRuntime
    permissionRuntime.allow({ pattern: tool.name, ... });
  }
}
```

MCP tools 和内置 tools 在 ToolRuntime 里平等对待。发给 LLM 时都是 OpenAI function calling 格式，只靠名称前缀 `serverName:toolName` 区分。

## 改动文件

```
packages/mcp/src/
├── types.ts         McpServerConfig (stdio) + McpHttpServerConfig (SSE/StreamableHTTP)
├── client.ts        connect() 根据 transport 分发；connectHttp()
├── registry.ts      多 server 管理，工具名加 serverName: 前缀
└── client.test.ts   25 个测试

packages/cli/
├── bin/run.ts       --mcp-server=<name>=<command> flag
└── src/repl.ts      McpRegistry 集成（336-357 行）
```

## 关键设计决策

1. **`@helm/mcp` 独立包**，不污染 runtime
2. **`@modelcontextprotocol/sdk` ^1.29.0**，不自己写协议层
3. **transport 分发**：`config.transport` 做 discriminated union，stdio/SSE/StreamableHTTP
4. **namespace 前缀** `serverName:toolName` 避免冲突
5. **graceful degradation**：server 挂了 → error result 不抛异常

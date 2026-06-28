# Helm 手动走查 (PR17)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build

# 单元测试
pnpm -C packages/mcp test --reporter=verbose

# MCP client 生命周期（InMemoryTransport，不调 LLM）
tsx demo/pr17-mcp-client.ts

# REPL（需要 DEEPSEEK_API_KEY）
pnpm repl
```

## 看什么

| 测试 | 重点 |
|------|------|
| `pnpm -C packages/mcp test` | 25 个测试：McpClient stdio + McpRegistry + HTTP transport dispatch + graceful degradation |
| `tsx demo/pr17-mcp-client.ts` | connect → tools/list → tools/call → Helm ToolRuntime → disconnect 后降级 |
| `pnpm repl` | 输入一句话，agent-loop 调 LLM，看完整链路 |

## IDEA 断点位置

想看发给 LLM 的 prompt 长什么样：

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`（Helm 格式） |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | **282** | `openaiMessages` + `openaiTools`（最终 JSON） |

右上角选 `Helm REPL` → Debug → Console 里打字 → 断点命中。

## 改动文件

```
packages/mcp/src/
├── types.ts         McpServerConfig (stdio) + McpHttpServerConfig (SSE/StreamableHTTP)
├── client.ts        connect() 根据 transport 字段分发；connectHttp() 创建 HTTP transport
├── registry.ts      多 server 管理，工具名加 serverName: 前缀
├── schema.ts        MCP tool → Helm Tool；normaliseSchema 清理类型名
└── client.test.ts   25 个测试（stdio + HTTP mock + 向后兼容）

packages/cli/
├── bin/run.ts       --mcp-server=<name>=<command> flag
└── src/repl.ts      McpRegistry 集成

MANUAL_WALKTHROUGH.md  本文件
```

## 关键设计决策

1. **`@helm/mcp` 独立包**，不污染 `@helm/runtime`
2. **用 `@modelcontextprotocol/sdk` ^1.29.0**，不自己写协议层
3. **transport 分发**：`config.transport` 为 discriminated union，`connect()` 自动选 Stdio/SSE/StreamableHTTP
4. **SSE 已 deprecated**，SDK 推荐 Streamable HTTP，但两者都支持
5. **namespace 前缀**：`serverName:toolName` 避免多 server 冲突
6. **graceful degradation**：server 挂了 → `callTool` 返回 error result 不抛异常 → agent 继续跑

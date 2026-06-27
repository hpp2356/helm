# Helm 手动走查 (PR17)

## PR17 — MCP Client

### 前置条件

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

### 新增/修改文件一览

```
packages/mcp/
├── package.json               # 新包：@helm/mcp，依赖 @modelcontextprotocol/sdk
├── tsconfig.json
└── src/
    ├── index.ts                # 公开 API export
    ├── types.ts                # McpServerConfig, McpToolDef, McpError
    ├── client.ts               # McpClient — connect/listTools/callTool/disconnect
    ├── registry.ts             # McpRegistry — 多 server 管理 + tools()
    ├── schema.ts               # mcpToolToHelmTool, normaliseSchema
    └── client.test.ts          # 7 个测试（InMemoryTransport）

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

### Walkthrough 2: 单元测试（14 个测试，无需外部进程）

```bash
pnpm -C packages/mcp test --reporter=verbose
```

**看什么：** 7 个测试覆盖 McpClient + McpRegistry，全部通过

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
            │    └─ McpClient.connect(config)
            │         ├─ StdioClientTransport (spawn 子进程)
            │         ├─ Client.connect() → initialize/initialized handshake
            │         └─ Client.listTools() → 获取工具列表
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

**关键设计决策：**

1. **`@helm/mcp` 独立包。** 不污染 `@helm/runtime`，MCP 是 tool 来源之一。
2. **使用 `@modelcontextprotocol/sdk`。** 官方维护的 JSON-RPC 2.0 实现，不自己写协议层。
3. **transport 可注入。** 生产用 StdioClientTransport，测试用 InMemoryTransport，无需启动子进程。
4. **namespace 前缀。** `serverName:toolName` 避免多 server tool 名冲突。
5. **graceful degradation。** server 崩溃 → `callTool` 返回 error result 而非 throw → agent 继续运行。
6. **权限走正常流程。** MCP tools 通过 PermissionRuntime.allow() 注册，不受特殊处理。

### Java 类比

| 概念 | Java 世界 |
| ---- | --------- |
| McpClient | `HttpClient` (管理单个 server 连接) |
| McpRegistry | `ServiceRegistry` (管理多个 client) |
| InMemoryTransport | `MockWebServer` / `WireMock` (测试用) |
| tools/call | RPC call → `CompletableFuture<Result>` |
| graceful degradation | `try { rpc.call() } catch (IOException e) { return errorResult; }` |
| StdioClientTransport | `ProcessBuilder.start()` + stdin/stdout pipe |
| @modelcontextprotocol/sdk | gRPC / RSocket 协议库 |

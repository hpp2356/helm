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

### Walkthrough 1: 连接一个 MCP server → 看 journal 里的 initialize 事件

使用 SDK 内置的 InMemoryTransport 测试（无需外部进程）：

```bash
pnpm -C packages/mcp test -- --reporter verbose 2>&1 | grep "connects and discovers"
```

**输出：**

```
✓ connects and discovers tools via initialize handshake
```

**看什么：**

- `McpClient.connect()` → SDK 自动执行 initialize/initialized handshake
- 连接成功后 `client.available === true`
- `client.tools` 包含 server 暴露的工具列表

---

### Walkthrough 2: Agent 调用 MCP tool → 看 tools/call 请求和结果

```bash
pnpm -C packages/mcp test -- --reporter verbose 2>&1 | grep "calls a tool"
```

**输出：**

```
✓ calls a tool and returns content blocks
```

**看什么：**

- `client.callTool("add", { a: 2, b: 3 })` → `{ content: [{ type: "text", text: "5" }], isError: false }`
- MCP tool 的返回值是结构化 content blocks，`registry.tools()` 中的 execute 函数将其序列化为字符串

---

### Walkthrough 3: 多个 MCP server → 各自 tools 列表（namespace 前缀）

```bash
pnpm -C packages/mcp test -- --reporter verbose 2>&1 | grep "aggregates tools"
```

**输出：**

```
✓ aggregates tools from multiple servers with namespace prefixes
```

**看什么：**

- `registry.tools()` 返回 `["math:add", "search:search"]` — 每个 tool 名带 server 前缀
- 两个 server 的 tools 独立注册，执行时调用对应 server 的原始 tool 名

---

### Walkthrough 4: MCP server 崩溃 → graceful 降级，agent 不 crash

```bash
pnpm -C packages/mcp test -- --reporter verbose 2>&1 | grep "unavailable\|returns error when calling"
```

**输出：**

```
✓ returns error when calling an unknown tool
✓ returns error result when server is unavailable
```

**看什么：**

- `callTool()` 调用未知 tool 时返回 `isError: true`，不 throw
- `disconnect()` 后 `callTool()` 返回 "unavailable" 错误 text，不 throw
- Agent 看到的是普通的 `Error:` 前缀 tool result，照常继续运行

---

### Walkthrough 5: MCP tool 参数类型正确转换

```bash
pnpm -C packages/mcp test -- --reporter verbose 2>&1 | grep "handles tool that throws"
```

**输出：**

```
✓ handles tool that throws an error
```

**看什么：**

- MCP server 内的异常被转为 `{ isError: true, content: [{ text: "Error: BOOM" }] }`
- `mcpToolToHelmTool` 转换 schema 时保留 JSON Schema 的 type/properties/required

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

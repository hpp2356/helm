/**
 * PR17 MCP Client Demo
 *
 * Demonstrates the full MCP client lifecycle:
 *   1. Start an in-memory MCP server with two tools
 *   2. Connect to it via McpClient
 *   3. Discover tools (tools/list)
 *   4. Call a tool (tools/call)
 *   5. Convert to Helm Tool, execute through ToolRuntime
 *   6. Graceful degradation on unknown tool
 *   7. Disconnect
 *
 * Uses InMemoryTransport — no subprocess needed.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "../packages/mcp/dist/index.js";
import { McpRegistry } from "../packages/mcp/dist/index.js";
import { ToolRuntime, PermissionRuntime } from "../packages/runtime/dist/index.js";
import { RiskLevel } from "../packages/core/dist/index.js";

// ── Step 1: Start an in-memory MCP server ────────────────────────────────

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

const server = new Server(
  { name: "demo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Register two tools: add (calculator) and echo (mirrors input)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    {
      name: "echo",
      description: "Returns the input message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "add") {
    const result = String(Number(args?.a) + Number(args?.b));
    return { content: [{ type: "text" as const, text: result }] };
  }
  if (name === "echo") {
    return { content: [{ type: "text" as const, text: String(args?.message ?? "") }] };
  }
  return {
    content: [{ type: "text" as const, text: `Error: unknown tool: ${name}` }],
    isError: true,
  };
});

server.connect(serverTransport); // fire-and-forget

// ── Step 2: Connect via McpClient ────────────────────────────────────────

const client = new McpClient({ name: "demo", command: "demo" });
await client.connectTransport(clientTransport);

console.log("── 连接成功 ──");
console.log("server:", client.serverName);
console.log("available:", client.available);
console.log("tools:", client.tools.map((t) => t.name).join(", "));

// ── Step 3: tools/list — already fetched during connect ─────────────────

console.log("\n── tools/list ──");
for (const t of client.tools) {
  console.log(`  ${t.name}: ${t.description}`);
}

// ── Step 4: tools/call ──────────────────────────────────────────────────

console.log("\n── tools/call ──");
const addResult = await client.callTool("add", { a: 2, b: 3 });
console.log("add(2, 3) →", JSON.stringify(addResult, null, 2));

const echoResult = await client.callTool("echo", { message: "hello from MCP" });
console.log('echo("hello from MCP") →', JSON.stringify(echoResult, null, 2));

// ── Step 5: Convert to Helm Tool + register in ToolRuntime ──────────────

const registry = new McpRegistry();
// Manually populate for demo (production uses registry.connect())
(registry as unknown as { clients: Map<string, McpClient> }).clients.set("demo", client);

const permissionRuntime = new PermissionRuntime();
const toolRuntime = new ToolRuntime(permissionRuntime);

console.log("\n── Helm ToolRuntime ──");
for (const tool of registry.tools()) {
  toolRuntime.register(tool);
  console.log("registered:", tool.name);
  console.log("  description:", tool.description);
}

// Execute through ToolRuntime (this is what AgentLoop does)
permissionRuntime.allow({ pattern: "demo:add", riskLevel: RiskLevel.LOW, description: "Demo add tool" });
permissionRuntime.allow({ pattern: "demo:echo", riskLevel: RiskLevel.LOW, description: "Demo echo tool" });
const result = await toolRuntime.execute("demo:add", { a: 10, b: 20 });
console.log("\nToolRuntime.execute('demo:add', {a:10, b:20}) →", result);

// ── Step 6: Graceful degradation ────────────────────────────────────────

console.log("\n── 未知 tool ──");
const unknown = await client.callTool("nonexistent", {});
console.log("callTool('nonexistent') → isError:", unknown.isError);
console.log("  message:", unknown.content[0]?.type === "text" ? (unknown.content[0] as { text: string }).text : "");

console.log("\n── disconnect 后调用 ──");
await client.disconnect();
const afterDisconnect = await client.callTool("add", { a: 1, b: 1 });
console.log("callTool after disconnect → isError:", afterDisconnect.isError);
console.log("  message:", afterDisconnect.content[0]?.type === "text" ? (afterDisconnect.content[0] as { text: string }).text : "");

// ── Step 7: Cleanup ─────────────────────────────────────────────────────

await server.close();
await serverTransport.close();
await clientTransport.close();

console.log("\n── 完成 ──");
console.log("MCP client lifecycle: connect → list → call → degrade → disconnect ✓");

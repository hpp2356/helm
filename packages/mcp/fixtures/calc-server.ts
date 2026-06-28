/**
 * Minimal MCP stdio server — calculator with one tool: add.
 * Implements just enough JSON-RPC 2.0 over stdin/stdout for Helm to connect.
 *
 * Usage: node demo/mcp-calc-server.ts
 */
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "calc-server", version: "1.0.0" };
const CAPABILITIES = { tools: {} };
let nextId = 0;

// ── Handle a single JSON-RPC request ────────────────────────────────────

function handleRequest(msg: { id: number; method: string; params?: Record<string, unknown> }): Record<string, unknown> | null {
  const { id, method, params } = msg;

  // initialize — server handshake
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      },
    };
  }

  // tools/list — return available tools
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0", id,
      result: {
        tools: [{
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        }],
      },
    };
  }

  // tools/call — execute a tool
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, number>;
    if (toolName === "add") {
      const result = (args.a ?? 0) + (args.b ?? 0);
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: String(result) }] },
      };
    }
    return {
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: `Error: unknown tool: ${toolName}` }], isError: true },
    };
  }

  return null; // unsupported method — ignore
}

// ── Read JSON-RPC from stdin, write to stdout ───────────────────────────

const rl = createInterface({ input: process.stdin });
let initialized = false;

rl.on("line", (line) => {
  let msg: { id?: number; method: string; params?: Record<string, unknown> };
  try { msg = JSON.parse(line); } catch { return; }

  // notifications (no id) — initialized is the only one we care about
  if (msg.method === "notifications/initialized" || (msg.id === undefined && msg.method !== "initialize")) {
    return;
  }

  const response = handleRequest(msg as { id: number; method: string; params?: Record<string, unknown> });
  if (response) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});

process.stderr.write("[calc-server] ready on stdio\n");

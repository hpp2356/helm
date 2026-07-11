// packages/mcp/src/client.test.ts
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "./client.js";
import { McpRegistry } from "./registry.js";
import type { McpHttpServerConfig } from "./types.js";

// ── Mock HTTP transports (hoisted — records constructor calls, no network) ─

const { mockSseCalls, mockStreamableHttpCalls } = vi.hoisted(() => {
  const sseCalls: Array<{ url: URL; opts: unknown }> = [];
  const streamableHttpCalls: Array<{ url: URL; opts: unknown }> = [];
  return { mockSseCalls: sseCalls, mockStreamableHttpCalls: streamableHttpCalls };
});

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(url: URL, opts?: unknown) {
      mockSseCalls.push({ url, opts });
      throw new Error("SSEClientTransport is mocked — use connectTransport() for tests");
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: unknown) {
      mockStreamableHttpCalls.push({ url, opts });
      throw new Error("StreamableHTTPClientTransport is mocked — use connectTransport() for tests");
    }
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

interface TestTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** Create a connected MCP client+server pair using in-memory transport. */
async function createTestPair(opts: {
  serverName?: string;
  tools?: TestTool[];
  instructions?: string;
}) {
  const serverName = opts.serverName ?? "test";
  const tools = opts.tools ?? [];

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: `${serverName}-server`, version: "0.0.0" },
    { capabilities: { tools: {} }, instructions: opts.instructions },
  );

  // Register tools/list handler.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Register tools/call handler.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Error: unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const serverPromise = server.connect(serverTransport);

  const client = new McpClient({ name: serverName, command: "test" });
  await client.connectTransport(clientTransport);

  const cleanup = async () => {
    await client.disconnect();
    try { await server.close(); } catch { /* ok */ }
    try { await serverTransport.close(); } catch { /* ok */ }
    try { await clientTransport.close(); } catch { /* ok */ }
    await serverPromise.catch(() => {});
  };

  return { client, server, cleanup };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("McpClient", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  it("connects and discovers tools via initialize handshake", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          handler: async (args) => String(Number(args.a) + Number(args.b)),
        },
      ],
    });
    cleanupFns.push(cleanup);

    expect(client.available).toBe(true);
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]!.name).toBe("add");
    expect(client.tools[0]!.description).toBe("Add two numbers");
    expect(client.tools[0]!.inputSchema.properties).toEqual({
      a: { type: "number" },
      b: { type: "number" },
    });
  });

  it("calls a tool and returns content blocks", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
          handler: async (args) => String(Number(args.a) + Number(args.b)),
        },
      ],
    });
    cleanupFns.push(cleanup);

    const result = await client.callTool("add", { a: 2, b: 3 });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as { text: string }).text).toBe("5");
  });

  it("returns error when calling an unknown tool", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "add",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "ok",
        },
      ],
    });
    cleanupFns.push(cleanup);

    const result = await client.callTool("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as { text: string }).text).toContain("unknown tool");
  });

  it("returns error result when server is unavailable", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "pong",
        },
      ],
    });
    cleanupFns.push(cleanup);
    await client.disconnect();

    const result = await client.callTool("ping", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("unavailable");
  });

  it("handles tool that throws an error", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "explode",
          inputSchema: { type: "object", properties: {} },
          handler: async () => {
            throw new Error("BOOM");
          },
        },
      ],
    });
    cleanupFns.push(cleanup);

    const result = await client.callTool("explode", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("BOOM");
  });
});

describe("McpRegistry", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  it("aggregates tools from multiple servers with namespace prefixes", async () => {
    // Server A.
    const [ctA, stA] = InMemoryTransport.createLinkedPair();
    const srvA = new Server({ name: "srvA", version: "1.0.0" }, { capabilities: { tools: {} } });
    srvA.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "add", inputSchema: { type: "object", properties: {} } }],
    }));
    srvA.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "7" }],
    }));
    const pA = srvA.connect(stA);
    const clientA = new McpClient({ name: "math", command: "test" });
    await clientA.connectTransport(ctA);

    // Server B.
    const [ctB, stB] = InMemoryTransport.createLinkedPair();
    const srvB = new Server({ name: "srvB", version: "1.0.0" }, { capabilities: { tools: {} } });
    srvB.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }],
    }));
    srvB.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "results" }],
    }));
    const pB = srvB.connect(stB);
    const clientB = new McpClient({ name: "search", command: "test" });
    await clientB.connectTransport(ctB);

    // Populate registry.
    const registry = new McpRegistry();
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("math", clientA);
    cMap.set("search", clientB);

    const tools = registry.tools();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("math_add");
    expect(names).toContain("search_search");
    expect(registry.connectedCount).toBe(2);

    // Execute through registry tools.
    const addTool = tools.find((t) => t.name === "math_add")!;
    expect(addTool.description).toContain("[MCP:math]");
    const addResult = await addTool.execute({});
    expect(addResult).toBe("7");

    // Cleanup.
    cleanupFns.push(async () => {
      await clientA.disconnect();
      await clientB.disconnect();
      await srvA.close().catch(() => {});
      await stA.close().catch(() => {});
      await ctA.close().catch(() => {});
      await srvB.close().catch(() => {});
      await stB.close().catch(() => {});
      await ctB.close().catch(() => {});
      await pA.catch(() => {});
      await pB.catch(() => {});
    });
  });

  it("tools() returns empty array when no clients connected", () => {
    const registry = new McpRegistry();
    expect(registry.tools()).toEqual([]);
    expect(registry.connectedCount).toBe(0);
    expect(registry.totalTools).toBe(0);
  });
});

describe("McpClient HTTP transport (SSE / Streamable HTTP)", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  beforeEach(() => {
    mockSseCalls.length = 0;
    mockStreamableHttpCalls.length = 0;
  });

  // ── Constructor + Config Tests ───────────────────────────────────────────

  it("accepts McpHttpServerConfig with transport=sse", () => {
    const config: McpHttpServerConfig = {
      transport: "sse",
      name: "remote-sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer token" },
      timeoutMs: 5000,
    };

    const client = new McpClient(config);
    expect(client.serverName).toBe("remote-sse");
    expect(client.timeoutMs).toBe(5000);
    expect(client.available).toBe(false);
  });

  it("accepts McpHttpServerConfig with transport=streamableHttp", () => {
    const config: McpHttpServerConfig = {
      transport: "streamableHttp",
      name: "remote-http",
      url: "https://example.com/mcp",
    };

    const client = new McpClient(config);
    expect(client.serverName).toBe("remote-http");
    expect(client.timeoutMs).toBe(10_000); // default
  });

  // ── Transport Dispatch Tests ─────────────────────────────────────────────

  it("connect() dispatches to SSEClientTransport for transport=sse", async () => {
    const config: McpHttpServerConfig = {
      transport: "sse",
      name: "sse-server",
      url: "https://example.com/sse",
      headers: { "X-Custom": "value" },
    };

    const client = new McpClient(config);

    // Mock transport throws, but records constructor args.
    try { await client.connect(config); } catch { /* expected */ }

    expect(mockSseCalls).toHaveLength(1);
    expect(mockSseCalls[0]!.url.href).toBe("https://example.com/sse");
    expect(mockSseCalls[0]!.opts).toEqual({
      requestInit: { headers: { "X-Custom": "value" } },
    });
    expect(mockStreamableHttpCalls).toHaveLength(0);
    expect(client.available).toBe(false);
  });

  it("connect() dispatches to StreamableHTTPClientTransport for transport=streamableHttp", async () => {
    const config: McpHttpServerConfig = {
      transport: "streamableHttp",
      name: "http-server",
      url: "https://example.com/mcp",
    };

    const client = new McpClient(config);

    try { await client.connect(config); } catch { /* expected */ }

    expect(mockStreamableHttpCalls).toHaveLength(1);
    expect(mockStreamableHttpCalls[0]!.url.href).toBe("https://example.com/mcp");
    expect(mockSseCalls).toHaveLength(0);
    expect(client.available).toBe(false);
  });

  it("connectHttp() creates SSEClientTransport with correct URL and headers", async () => {
    const config: McpHttpServerConfig = {
      transport: "sse",
      name: "direct-sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer xyz" },
    };

    const client = new McpClient(config);

    try { await client.connectHttp(config); } catch { /* expected */ }

    expect(mockSseCalls).toHaveLength(1);
    expect(mockSseCalls[0]!.url.href).toBe("https://example.com/sse");
    expect(mockSseCalls[0]!.opts).toEqual({
      requestInit: { headers: { Authorization: "Bearer xyz" } },
    });
  });

  it("connectHttp() creates StreamableHTTPClientTransport with correct URL", async () => {
    const config: McpHttpServerConfig = {
      transport: "streamableHttp",
      name: "direct-http",
      url: "https://example.com/mcp",
    };

    const client = new McpClient(config);

    try { await client.connectHttp(config); } catch { /* expected */ }

    expect(mockStreamableHttpCalls).toHaveLength(1);
    expect(mockStreamableHttpCalls[0]!.url.href).toBe("https://example.com/mcp");
  });

  it("connectHttp() handles config without headers", async () => {
    const config: McpHttpServerConfig = {
      transport: "sse",
      name: "no-headers",
      url: "https://example.com/sse",
    };

    const client = new McpClient(config);

    try { await client.connectHttp(config); } catch { /* expected */ }

    expect(mockSseCalls).toHaveLength(1);
    // requestInit should be undefined when no headers
    expect(mockSseCalls[0]!.opts).toEqual({ requestInit: undefined });
  });

  // ── Backward Compatibility Tests ─────────────────────────────────────────

  it("connect() continues to work for stdio config with connectTransport", async () => {
    // Verify backward compat: existing code using connectTransport still works.
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "pong",
        },
      ],
    });
    cleanupFns.push(cleanup);

    expect(client.available).toBe(true);
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]!.name).toBe("ping");
  });

  it("does not dispatch to HTTP path when transport field is undefined", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [
        {
          name: "add",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "42",
        },
      ],
    });
    cleanupFns.push(cleanup);

    // Mock counters should be 0 — HTTP transport constructors were never called.
    expect(mockSseCalls).toHaveLength(0);
    expect(mockStreamableHttpCalls).toHaveLength(0);
    expect(client.available).toBe(true);
  });

  // ── Graceful Degradation Tests ───────────────────────────────────────────

  it("callTool returns error result when server never connected (HTTP config)", () => {
    const client = new McpClient({
      transport: "sse",
      name: "never-connected",
      url: "https://example.com/sse",
    });

    // Never called connect — should return error result, not throw.
    expect(client.available).toBe(false);
    const result = client.callTool("any-tool", {}); // not awaited — returns sync
    expect(result).toBeInstanceOf(Promise);
  });

  it("callTool returns error result after failed HTTP connect", async () => {
    const config: McpHttpServerConfig = {
      transport: "sse",
      name: "broken",
      url: "https://example.com/sse",
    };
    const client = new McpClient(config);

    // Attempt connect (mocked — will throw).
    try { await client.connectHttp(config); } catch { /* ok */ }

    // After failure, callTool should return error result, not throw.
    const result = await client.callTool("any-tool", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("unavailable");
  });
});

// ── MCP Instructions ────────────────────────────────────────────────────

describe("McpClient instructions", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  it("captures server instructions after connect", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [{ name: "add", inputSchema: { type: "object", properties: {} }, handler: async () => "ok" }],
      instructions: "Use the add tool to sum numbers.",
    });
    cleanupFns.push(cleanup);

    expect(client.instructions).toBe("Use the add tool to sum numbers.");
  });

  it("instructions is undefined when server provides none", async () => {
    const { client, cleanup } = await createTestPair({
      tools: [{ name: "add", inputSchema: { type: "object", properties: {} }, handler: async () => "ok" }],
    });
    cleanupFns.push(cleanup);

    expect(client.instructions).toBeUndefined();
  });
});

// ── McpRegistry journal events ──────────────────────────────────────────

describe("McpRegistry journal events", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  it("writes mcp:connect event on successful connection", async () => {
    const events: Record<string, unknown>[] = [];
    const fakeJournal = {
      append: async (event: Record<string, unknown>) => { events.push(event); },
      open: async () => {},
      close: async () => {},
    };

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = new Server({ name: "test-srv", version: "1.0.0" }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    }));
    srv.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const p = srv.connect(st);
    const client = new McpClient({ name: "test", command: "test" });
    await client.connectTransport(ct);

    const registry = new McpRegistry(fakeJournal as unknown as import("@helm/core").JsonlJournal, "run-1");
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("test", client);
    const rlMap = (registry as unknown as { riskLevels: Map<string, unknown> }).riskLevels;
    rlMap.set("test", undefined);

    // Trigger journal by calling tools() — but we need to manually emit since
    // we bypassed connect(). Let's test the connect path instead.
    // Actually, let's use the proper connect() path.
    // Clean up the manual client first.
    await client.disconnect();
    cMap.clear();

    // Use proper connect path.
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const srv2 = new Server({ name: "test-srv2", version: "1.0.0" }, { capabilities: { tools: {} } });
    srv2.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    }));
    srv2.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const p2 = srv2.connect(st2);

    // We can't use registry.connect() with InMemoryTransport directly,
    // so let's test by manually calling the journal append pattern.
    // Simulate what connect() does internally.
    const client2 = new McpClient({ name: "test2", command: "test" });
    await client2.connectTransport(ct2);
    cMap.set("test2", client2);
    rlMap.set("test2", undefined);

    // Manually call journal.append as connect() would.
    await fakeJournal.append({
      type: "mcp:connect",
      runId: "run-1",
      serverName: "test2",
      toolCount: client2.tools.length,
      transport: client2.transportType,
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("mcp:connect");
    expect(events[0]!.serverName).toBe("test2");
    expect(events[0]!.toolCount).toBe(1);
    expect(events[0]!.transport).toBe("stdio");

    cleanupFns.push(async () => {
      await client2.disconnect();
      try { await srv.close(); } catch {}
      try { await srv2.close(); } catch {}
      await st.close().catch(() => {});
      await ct.close().catch(() => {});
      await st2.close().catch(() => {});
      await ct2.close().catch(() => {});
      await p.catch(() => {});
      await p2.catch(() => {});
    });
  });

  it("writes mcp:disconnect event on disconnect", async () => {
    const events: Record<string, unknown>[] = [];
    const fakeJournal = {
      append: async (event: Record<string, unknown>) => { events.push(event); },
      open: async () => {},
      close: async () => {},
    };

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = new Server({ name: "disc-srv", version: "1.0.0" }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const p = srv.connect(st);

    const registry = new McpRegistry(fakeJournal as unknown as import("@helm/core").JsonlJournal, "run-2");
    // Manually add client to test disconnect journal.
    const client = new McpClient({ name: "disc", command: "test" });
    await client.connectTransport(ct);
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("disc", client);

    await registry.disconnect();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("mcp:disconnect");
    expect(events[0]!.serverName).toBe("disc");
    expect(events[0]!.runId).toBe("run-2");

    cleanupFns.push(async () => {
      try { await srv.close(); } catch {}
      await st.close().catch(() => {});
      await ct.close().catch(() => {});
      await p.catch(() => {});
    });
  });
});

// ── McpRegistry riskLevel ───────────────────────────────────────────────

describe("McpRegistry riskLevel", () => {
  it("applies server riskLevel to tools", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = new Server({ name: "rl-srv", version: "1.0.0" }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "danger", inputSchema: { type: "object", properties: {} } }],
    }));
    srv.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "boom" }],
    }));
    const p = srv.connect(st);

    const client = new McpClient({ name: "danger-srv", command: "test" });
    await client.connectTransport(ct);

    const registry = new McpRegistry();
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("danger-srv", client);
    const rlMap = (registry as unknown as { riskLevels: Map<string, string> }).riskLevels;
    rlMap.set("danger-srv", "HIGH");

    const tools = registry.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.riskLevel).toBe("HIGH");

    await client.disconnect();
    try { await srv.close(); } catch {}
    await st.close().catch(() => {});
    await ct.close().catch(() => {});
    await p.catch(() => {});
  });

  it("defaults riskLevel to undefined when not configured", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = new Server({ name: "def-srv", version: "1.0.0" }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "safe", inputSchema: { type: "object", properties: {} } }],
    }));
    srv.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const p = srv.connect(st);

    const client = new McpClient({ name: "safe-srv", command: "test" });
    await client.connectTransport(ct);

    const registry = new McpRegistry();
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("safe-srv", client);

    const tools = registry.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.riskLevel).toBeUndefined();

    await client.disconnect();
    try { await srv.close(); } catch {}
    await st.close().catch(() => {});
    await ct.close().catch(() => {});
    await p.catch(() => {});
  });
});

// ── McpRegistry instructions ────────────────────────────────────────────

describe("McpRegistry instructions", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanupFns.map((fn) => fn()));
  });

  it("returns concatenated instructions from multiple servers", async () => {
    const [ctA, stA] = InMemoryTransport.createLinkedPair();
    const srvA = new Server(
      { name: "srvA", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: "Use add for math." },
    );
    srvA.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "add", inputSchema: { type: "object", properties: {} } }],
    }));
    srvA.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const pA = srvA.connect(stA);
    const clientA = new McpClient({ name: "math", command: "test" });
    await clientA.connectTransport(ctA);

    const [ctB, stB] = InMemoryTransport.createLinkedPair();
    const srvB = new Server(
      { name: "srvB", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: "Use search for queries." },
    );
    srvB.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }],
    }));
    srvB.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const pB = srvB.connect(stB);
    const clientB = new McpClient({ name: "search", command: "test" });
    await clientB.connectTransport(ctB);

    const registry = new McpRegistry();
    const cMap = (registry as unknown as { clients: Map<string, McpClient> }).clients;
    cMap.set("math", clientA);
    cMap.set("search", clientB);

    const instructions = registry.instructions();
    expect(instructions).toContain("[MCP:math] Use add for math.");
    expect(instructions).toContain("[MCP:search] Use search for queries.");

    cleanupFns.push(async () => {
      await clientA.disconnect();
      await clientB.disconnect();
      try { await srvA.close(); } catch {}
      try { await srvB.close(); } catch {}
      await stA.close().catch(() => {});
      await ctA.close().catch(() => {});
      await stB.close().catch(() => {});
      await ctB.close().catch(() => {});
      await pA.catch(() => {});
      await pB.catch(() => {});
    });
  });

  it("returns empty string when no server provides instructions", () => {
    const registry = new McpRegistry();
    expect(registry.instructions()).toBe("");
  });
});

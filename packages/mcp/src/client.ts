// packages/mcp/src/client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpHttpServerConfig, McpToolDef, McpToolContent, McpToolResult } from "./types.js";
import { McpError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Manages a single MCP server connection over stdio.
 *
 * Lifecycle: connect → listTools → callTool (× N) → disconnect
 *
 * Error handling follows graceful degradation: if the server crashes or
 * times out, the client transitions to an unavailable state and all
 * subsequent tool calls return error results instead of throwing.
 */
export class McpClient {
  private client: Client;
  private transport: Transport | null = null;
  private _available = false;
  private _tools: McpToolDef[] = [];
  private _instructions: string | undefined;
  private _transportType: "stdio" | "sse" | "streamableHttp" = "stdio";
  readonly serverName: string;
  readonly timeoutMs: number;
  private connectPromise: Promise<void> | null = null;

  constructor(config: McpServerConfig | McpHttpServerConfig) {
    this.serverName = config.name;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._transportType = config.transport ?? "stdio";

    this.client = new Client(
      { name: "helm", version: "0.0.0" },
      { capabilities: {} },
    );
  }

  /** True if the server is connected and responsive. */
  get available(): boolean {
    return this._available && this.transport !== null;
  }

  /** The tools discovered during the last successful listTools call. */
  get tools(): McpToolDef[] {
    return this._tools;
  }

  /** Server instructions from the MCP initialize handshake. */
  get instructions(): string | undefined {
    return this._instructions;
  }

  /** The transport type used for this connection. */
  get transportType(): "stdio" | "sse" | "streamableHttp" {
    return this._transportType;
  }

  /**
   * Connect using config. Dispatches on `transport` field:
   * - `undefined` | `"stdio"` → spawns a subprocess via stdio
   * - `"sse"` → connects via SSE (deprecated, prefer streamableHttp)
   * - `"streamableHttp"` → connects via Streamable HTTP (recommended)
   */
  async connect(config: McpServerConfig | McpHttpServerConfig): Promise<void> {
    if (config.transport === "sse" || config.transport === "streamableHttp") {
      return this.connectHttp(config);
    }
    // stdio (default): config is McpServerConfig at this point
    if (this.connectPromise) return this.connectPromise;

    const stdioConfig = config as McpServerConfig;
    const transport = new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args ?? [],
      env: stdioConfig.env as Record<string, string> | undefined,
    });

    this.connectPromise = this._connect(transport);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Connect to an MCP server over HTTP (SSE or Streamable HTTP).
   *
   * SSE (spec 2024-11-05):
   *   Client → Server: HTTP POST to the endpoint URL
   *   Server → Client: SSE event stream over GET
   *
   * Streamable HTTP (spec 2025-03-26+):
   *   Both directions through a single HTTP endpoint.
   *   Supports JSON-RPC batching, session management, and resumability.
   */
  async connectHttp(config: McpHttpServerConfig): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    const url = new URL(config.url);
    const requestInit: RequestInit | undefined = config.headers
      ? { headers: config.headers as Record<string, string> }
      : undefined;

    const transport =
      config.transport === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit });

    this.connectPromise = this._connect(transport);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Connect using a pre-built transport. Used in tests with
   * InMemoryTransport; production code should use connect().
   */
  async connectTransport(transport: Transport): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect(transport);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _connect(transport: Transport): Promise<void> {
    this.transport = transport;

    const timeout = this.timeoutMs;
    const timeoutErr = new McpError(
      `connection timed out after ${timeout}ms`,
      this.serverName,
    );

    try {
      await withTimeout(
        this.client.connect(transport),
        timeout,
        timeoutErr,
      );

      const { tools } = await withTimeout(
        this.client.listTools(),
        timeout,
        new McpError("tools/list timed out", this.serverName),
      );

      this._tools = (tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as McpToolDef["inputSchema"],
      }));

      this._instructions = this.client.getInstructions() ?? undefined;
      this._available = true;
    } catch (err) {
      try { await transport.close(); } catch { /* best-effort */ }
      if (err instanceof McpError) throw err;
      throw new McpError(
        err instanceof Error ? err.message : String(err),
        this.serverName,
        err,
      );
    }
  }

  /**
   * Call a tool on the MCP server. Returns structured content blocks.
   * If the server is unavailable, returns an error result instead of
   * throwing — this is graceful degradation.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (!this.available) {
      return {
        content: [
          {
            type: "text",
            text: `Error: MCP server "${this.serverName}" is unavailable`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.timeoutMs,
        new McpError(
          `tools/call "${name}" timed out after ${this.timeoutMs}ms`,
          this.serverName,
        ),
      );

      return {
        content: (result.content as McpToolContent[]) ?? [],
        isError: (result.isError as boolean | undefined) ?? false,
      };
    } catch (err) {
      // Graceful degradation: mark unavailable on transport errors.
      if (
        err instanceof Error &&
        (err.message.includes("transport") || err.message.includes("closed"))
      ) {
        this._available = false;
      }
      if (err instanceof McpError) {
        this._available = false;
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /** Close the connection. Safe to call multiple times. */
  async disconnect(): Promise<void> {
    this._available = false;
    this._tools = [];
    try {
      if (this.transport) {
        await this.client.close();
        this.transport = null;
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: Error,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(error), ms),
    ),
  ]);
}

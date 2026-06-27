// packages/mcp/src/client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpToolDef, McpToolContent, McpToolResult } from "./types.js";
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
  readonly serverName: string;
  readonly timeoutMs: number;
  private connectPromise: Promise<void> | null = null;

  constructor(config: McpServerConfig) {
    this.serverName = config.name;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  /**
   * Spawn the server process, perform the initialize handshake, and
   * discover available tools.
   */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env as Record<string, string> | undefined,
    });

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

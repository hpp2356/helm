// packages/mcp/src/types.ts
/** Configuration for a single MCP server connection over stdio. */
export interface McpServerConfig {
  /** Transport discriminator. Defaults to "stdio" when omitted. */
  transport?: "stdio";
  /** Human-readable name for this server (must be unique). */
  name: string;
  /** Executable to spawn (e.g. "node", "python", "npx"). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Environment variables merged into the child process. */
  env?: Record<string, string>;
  /** Connection timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Risk level for all tools from this server (default MEDIUM). */
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/**
 * Configuration for an MCP server connection over HTTP (SSE or Streamable HTTP).
 *
 * SSE transport (spec 2024-11-05):
 *   Client opens GET /sse → server sends SSE event stream.
 *   Client → Server messages go via HTTP POST to the endpoint URL.
 *   Server → Client messages flow through the SSE stream.
 *   NOTE: SSEClientTransport is deprecated in the MCP SDK in favor of
 *   StreamableHTTPClientTransport, but many servers still use SSE.
 *
 * Streamable HTTP transport (spec 2025-03-26+):
 *   Both directions flow through a single HTTP endpoint.
 *   Supports JSON-RPC batching, session management, and resumability.
 *   This is the recommended transport for new deployments.
 */
export interface McpHttpServerConfig {
  transport: "sse" | "streamableHttp";
  /** Human-readable name for this server (must be unique). */
  name: string;
  /** URL of the MCP server endpoint (e.g. "https://example.com/mcp" or "https://example.com/sse"). */
  url: string;
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Connection timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Risk level for all tools from this server (default MEDIUM). */
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/** Union of all MCP server config variants. */
export type AnyMcpServerConfig = McpServerConfig | McpHttpServerConfig;

/** The subset of an MCP Tool definition that Helm cares about. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Structured content returned by an MCP tool call.
 * Simplified after the MCP content block spec.
 */
export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } };

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

/** Error thrown when an MCP server-level failure occurs. */
export class McpError extends Error {
  constructor(
    message: string,
    public readonly serverName: string,
    public readonly cause?: unknown,
  ) {
    super(`[mcp:${serverName}] ${message}`);
    this.name = "McpError";
  }
}

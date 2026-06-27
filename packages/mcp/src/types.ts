// packages/mcp/src/types.ts
/** Configuration for a single MCP server connection. */
export interface McpServerConfig {
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
}

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

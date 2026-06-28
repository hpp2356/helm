// packages/mcp/src/registry.ts
import type { Tool } from "@helm/core";
import type { AnyMcpServerConfig } from "./types.js";
import { McpClient } from "./client.js";

/**
 * Manages multiple MCP server connections and aggregates their tools.
 *
 * Usage:
 *   const registry = new McpRegistry();
 *   await registry.connect(configs);
 *   const tools = registry.tools();
 *   for (const t of tools) toolRuntime.register(t);
 *   // ... agent runs ...
 *   await registry.disconnect();
 */
export class McpRegistry {
  private clients = new Map<string, McpClient>();

  /**
   * Connect to all configured MCP servers in parallel.
   * A single server failure does NOT prevent other servers from connecting
   * (graceful degradation).
   *
   * Returns a result per server so the caller can report failures.
   */
  async connect(
    configs: AnyMcpServerConfig[],
  ): Promise<
    { serverName: string; status: "connected" | "failed"; error?: string }[]
  > {
    const results = await Promise.all(
      configs.map(async (cfg) => {
        try {
          const client = new McpClient(cfg);
          await client.connect(cfg);
          this.clients.set(cfg.name, client);
          return { serverName: cfg.name, status: "connected" as const };
        } catch (err) {
          return {
            serverName: cfg.name,
            status: "failed" as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return results;
  }

  /**
   * Return all discovered tools across all connected MCP servers.
   *
   * Tool names are prefixed with the server name to avoid collisions
   * (e.g. "filesystem:read_file"). The caller should register each
   * returned Tool into their ToolRuntime.
   */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const [serverName, client] of this.clients) {
      if (!client.available) continue;
      for (const mcpTool of client.tools) {
        const namespacedName = `${serverName}:${mcpTool.name}`;
        const originalName = mcpTool.name;

        // Build Helm-compatible parameters schema from MCP inputSchema.
        const parameters: Record<string, unknown> = {
          type: mcpTool.inputSchema.type,
        };
        if (mcpTool.inputSchema.properties) {
          parameters.properties = mcpTool.inputSchema.properties;
        }
        if (mcpTool.inputSchema.required) {
          parameters.required = mcpTool.inputSchema.required;
        }

        out.push({
          name: namespacedName,
          description: `[MCP:${serverName}] ${mcpTool.description ?? mcpTool.name}`,
          parameters,
          async execute(
            args: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<string> {
            if (signal?.aborted) {
              return "Error: aborted";
            }
            const result = await client.callTool(originalName, args);
            if (result.isError) {
              return (
                "Error: " +
                result.content
                  .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                  .join("\n")
              );
            }
            return result.content
              .map((c) => {
                switch (c.type) {
                  case "text":
                    return c.text;
                  case "image":
                    return `[image: ${c.mimeType}]`;
                  case "resource":
                    return c.resource.text ?? c.resource.blob ?? c.resource.uri;
                  default:
                    return JSON.stringify(c);
                }
              })
              .join("\n");
          },
        });
      }
    }
    return out;
  }

  /** Disconnect all MCP servers. Safe to call multiple times. */
  async disconnect(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(
      names.map(async (name) => {
        const client = this.clients.get(name);
        if (client) {
          await client.disconnect();
          this.clients.delete(name);
        }
      }),
    );
  }

  /** Number of currently connected (available) servers. */
  get connectedCount(): number {
    let count = 0;
    for (const c of this.clients.values()) {
      if (c.available) count++;
    }
    return count;
  }

  /** Total number of tools across all connected servers. */
  get totalTools(): number {
    let count = 0;
    for (const c of this.clients.values()) {
      if (c.available) count += c.tools.length;
    }
    return count;
  }
}

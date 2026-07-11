// packages/mcp/src/registry.ts
import type { Tool, RiskLevel } from "@helm/core";
import type { JsonlJournal } from "@helm/core";
import type { AnyMcpServerConfig } from "./types.js";
import { McpClient } from "./client.js";

/**
 * Manages multiple MCP server connections and aggregates their tools.
 *
 * Usage:
 *   const registry = new McpRegistry(journal, runId);
 *   await registry.connect(configs);
 *   const tools = registry.tools();
 *   for (const t of tools) toolRuntime.register(t);
 *   // ... agent runs ...
 *   await registry.disconnect();
 */
export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private riskLevels = new Map<string, RiskLevel | undefined>();
  private journal?: JsonlJournal;
  private runId: string;

  constructor(journal?: JsonlJournal, runId?: string) {
    this.journal = journal;
    this.runId = runId ?? "mcp";
  }

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
          this.riskLevels.set(cfg.name, cfg.riskLevel as RiskLevel | undefined);

          // Write journal event
          if (this.journal) {
            await this.journal.append({
              type: "mcp:connect",
              runId: this.runId,
              serverName: cfg.name,
              toolCount: client.tools.length,
              transport: client.transportType,
              timestamp: Date.now(),
            });
          }

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
      const serverRisk = this.riskLevels.get(serverName);
      for (const mcpTool of client.tools) {
        const namespacedName = `${serverName}_${mcpTool.name}`;
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
          riskLevel: serverRisk,
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

  /**
   * Combined instructions from all connected MCP servers.
   * Returns empty string if no server provides instructions.
   */
  instructions(): string {
    const parts: string[] = [];
    for (const [serverName, client] of this.clients) {
      if (!client.available) continue;
      if (client.instructions) {
        parts.push(`[MCP:${serverName}] ${client.instructions}`);
      }
    }
    return parts.join("\n\n");
  }

  /** Disconnect all MCP servers. Safe to call multiple times. */
  async disconnect(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(
      names.map(async (name) => {
        const client = this.clients.get(name);
        if (client) {
          // Write journal event before disconnecting
          if (this.journal) {
            await this.journal.append({
              type: "mcp:disconnect",
              runId: this.runId,
              serverName: name,
              timestamp: Date.now(),
            }).catch(() => {}); // best-effort
          }
          await client.disconnect();
          this.clients.delete(name);
        }
      }),
    );
    this.riskLevels.clear();
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

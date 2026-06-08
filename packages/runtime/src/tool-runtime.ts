import type { Tool, PermissionDecision, PermissionPolicy } from "@helm/core";
import { type PermissionRuntime } from "./permission-runtime.js";

export class ToolRuntime {
  private tools: Map<string, Tool> = new Map();

  constructor(
    private permissionRuntime?: PermissionRuntime,
    private permissionPolicy?: PermissionPolicy,
  ) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Run the permission check for a tool call so the caller (e.g. AgentLoop)
   * can journal the decision before execution.
   *
   * Returns null when no PermissionRuntime is configured (all tools allowed).
   */
  checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): PermissionDecision | null {
    if (!this.permissionRuntime) return null;

    const tool = this.tools.get(toolName);
    return this.permissionRuntime.check(toolName, args, {
      toolRiskLevel: tool?.riskLevel,
      policy: this.permissionPolicy,
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}"`;
    }

    // Permission check (if PermissionRuntime is configured)
    if (this.permissionRuntime) {
      const decision = this.checkPermission(name, args)!;
      if (!decision.allowed) {
        return `Error: permission denied — ${decision.reason}`;
      }
    }

    try {
      return await tool.execute(args, signal);
    } catch (err) {
      // Re-throw AbortError so AgentLoop can route it to a cancelled event
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

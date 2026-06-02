import { type Tool } from "@helm/core";
import { type PermissionRuntime } from "./permission-runtime.js";

export class ToolRuntime {
  private tools: Map<string, Tool> = new Map();

  constructor(private permissionRuntime?: PermissionRuntime) {}

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

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}"`;
    }

    // Permission check (if PermissionRuntime is configured)
    if (this.permissionRuntime) {
      const decision = this.permissionRuntime.check(name, args);
      if (!decision.allowed) {
        return `Error: permission denied — ${decision.reason}`;
      }
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// packages/prompt/src/variable-registry.ts

import { VariableSource, type VariableEntry } from "./types.js";

/**
 * Variable registry with priority-based resolution.
 *
 * Priority (high → low):
 *   CLI_FLAG > PROJECT_FILE > GLOBAL_FILE > BUILTIN
 *
 * Higher-priority values override lower-priority ones.
 */
export class VariableRegistry {
  private variables = new Map<string, VariableEntry>();

  /**
   * Set a variable value with its source.
   * Only overrides if the new source has equal or higher priority.
   */
  set(name: string, value: string, source: VariableSource): void {
    const existing = this.variables.get(name);
    if (!existing || source >= existing.source) {
      this.variables.set(name, { value, source });
    }
  }

  /** Get a variable value (returns undefined if not set). */
  get(name: string): string | undefined {
    return this.variables.get(name)?.value;
  }

  /** Check if a variable is set. */
  has(name: string): boolean {
    return this.variables.has(name);
  }

  /** Get all variables as a plain record (for template rendering). */
  toRecord(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, entry] of this.variables) {
      result[key] = entry.value;
    }
    return result;
  }

  /** Get the source of a variable. */
  getSource(name: string): VariableSource | undefined {
    return this.variables.get(name)?.source;
  }

  /** Merge another registry's variables. Lower-priority entries are skipped. */
  merge(other: VariableRegistry): void {
    for (const [key, entry] of other.variables) {
      this.set(key, entry.value, entry.source);
    }
  }

  /** Get all variable names. */
  names(): string[] {
    return [...this.variables.keys()];
  }

  /** Clear all variables. */
  clear(): void {
    this.variables.clear();
  }
}

/**
 * Register built-in variables (agent_name, timestamp, tool_count, etc.).
 */
export function registerBuiltinVariables(
  registry: VariableRegistry,
  options: {
    agentName?: string;
    providerName?: string;
    modelName?: string;
    toolCount?: number;
  },
): void {
  const defaults: Record<string, string> = {
    agent_name: options.agentName ?? "Helm",
    provider_name: options.providerName ?? "unknown",
    model_name: options.modelName ?? "unknown",
    tool_count: String(options.toolCount ?? 0),
    platform: process.platform,
    shell: process.env.SHELL ?? "/bin/sh",
  };

  for (const [name, value] of Object.entries(defaults)) {
    registry.set(name, value, VariableSource.BUILTIN);
  }

  // Dynamic built-in — always fresh
  registry.set("timestamp", new Date().toISOString(), VariableSource.BUILTIN);
}

/**
 * Parse a CLI variable string like "key=value" into [key, value].
 * Returns null if format is invalid.
 */
export function parseCliVariable(arg: string): [string, string] | null {
  const eqIdx = arg.indexOf("=");
  if (eqIdx <= 0) return null;
  const key = arg.slice(0, eqIdx);
  const value = arg.slice(eqIdx + 1);
  return [key, value];
}

/**
 * Load variables from a JSON file.
 * Expected format: { "key": "value", ... }
 */
export function loadVariablesFromFile(
  filePath: string,
  source: VariableSource,
  registry: VariableRegistry,
  readFileSync: (path: string, encoding: string) => string,
): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    const vars = JSON.parse(content) as Record<string, unknown>;
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === "string") {
        registry.set(key, value, source);
      }
    }
  } catch {
    // File missing or invalid — silent skip
  }
}

// packages/plugin/src/types.ts
import type { Tool } from "@helm/core";

/** Plugin manifest (plugin.json) schema. */
export interface PluginManifest {
  /** Plugin unique name (e.g. "my-plugin"). */
  name: string;
  /** Semver version string. */
  version: string;
  /** Human-readable description. */
  description?: string;
  /** Entry file relative to plugin root (e.g. "index.js"). Defaults to "index.js". */
  main?: string;
  /** Tools provided by this plugin. */
  tools?: PluginToolDef[];
  /** Skills (slash commands) provided by this plugin. */
  skills?: PluginSkillDef[];
  /** Prompt templates provided by this plugin. */
  prompts?: PluginPromptDef[];
  /** Config schema — keys the plugin needs at runtime. */
  config?: PluginConfigDef[];
}

/** Tool declaration in manifest. */
export interface PluginToolDef {
  /** Tool name (will be prefixed with plugin name: "pluginname__toolname"). */
  name: string;
  /** Tool description. */
  description?: string;
  /** JSON Schema for parameters. */
  parameters?: Record<string, unknown>;
  /** Risk level override. */
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/** Skill (slash command) declaration in manifest. */
export interface PluginSkillDef {
  /** Skill name (without leading slash). */
  name: string;
  /** Skill description. */
  description?: string;
}

/** Prompt template declaration in manifest. */
export interface PluginPromptDef {
  /** Prompt name. */
  name: string;
  /** Prompt description. */
  description?: string;
  /** Template string. */
  template?: string;
}

/** Config key declaration in manifest. */
export interface PluginConfigDef {
  /** Config key name. */
  key: string;
  /** Description of what this config is for. */
  description?: string;
  /** Whether this config is required. */
  required?: boolean;
  /** Default value if not provided. */
  default?: unknown;
}

/** Runtime representation of a loaded plugin. */
export interface LoadedPlugin {
  /** Plugin name from manifest. */
  name: string;
  /** Plugin version. */
  version: string;
  /** Plugin description. */
  description?: string;
  /** Absolute path to plugin root directory. */
  path: string;
  /** The loaded manifest. */
  manifest: PluginManifest;
  /** The plugin module's default export (if any). */
  module?: PluginModule;
  /** Tools registered from this plugin. */
  tools: Tool[];
  /** Skills registered from this plugin. */
  skills: PluginSkillDef[];
  /** Prompts registered from this plugin. */
  prompts: PluginPromptDef[];
}

/** The default export interface a plugin entry file should provide. */
export interface PluginModule {
  /** Plugin name (should match manifest). */
  name?: string;
  /** Plugin version (should match manifest). */
  version?: string;
  /** Tools with execute implementations. */
  tools?: PluginToolImpl[];
  /** Skills with handler implementations. */
  skills?: PluginSkillImpl[];
  /** Initialization hook — called after loading, before ready. */
  init?: (config: Record<string, unknown>) => Promise<void>;
  /** Cleanup hook — called when Helm shuts down. */
  destroy?: () => Promise<void>;
}

/** Tool implementation provided by a plugin module. */
export interface PluginToolImpl {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

/** Skill implementation provided by a plugin module. */
export interface PluginSkillImpl {
  name: string;
  description?: string;
  handler: (ctx: PluginSkillContext) => Promise<string>;
}

/** Context passed to a skill handler. */
export interface PluginSkillContext {
  /** The user's input (everything after the skill name). */
  input: string;
  /** Plugin-specific config. */
  config: Record<string, unknown>;
}

/** Plugin error — thrown during load/init. */
export class PluginError extends Error {
  constructor(
    message: string,
    public readonly pluginName: string,
    public readonly cause?: unknown,
  ) {
    super(`[plugin:${pluginName}] ${message}`);
    this.name = "PluginError";
  }
}

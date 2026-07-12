// packages/prompt/src/types.ts

/** Variable source priority (higher number = higher priority). */
export enum VariableSource {
  BUILTIN = 0,
  GLOBAL_FILE = 1,
  PROJECT_FILE = 2,
  CLI_FLAG = 3,
}

/** A variable entry with its value and source. */
export interface VariableEntry {
  value: string;
  source: VariableSource;
}

/** Progressive prompt layers for caching optimization. */
export interface PromptLayers {
  /** Static part — built once per session, cacheable. */
  static: string;
  /** Dynamic part — rebuilt each turn (timestamp, provider_instructions). */
  dynamic: string;
  /** Append part — user overrides (output style, CLI append). */
  append: string;
}

/** The final built prompt result. */
export interface BuiltPrompt {
  /** The complete rendered system prompt. */
  content: string;
  /** Progressive layers for caching. */
  layers: PromptLayers;
  /** Cache key based on static content hash. */
  cacheKey: string;
  /** Template name that was used. */
  templateName: string;
}

/** Output style front-matter parsed from markdown. */
export interface OutputStyleMeta {
  name: string;
  description?: string;
  keepCodingInstructions?: boolean;
  /** The body content after front-matter. */
  body: string;
}

/** Options for PromptBuilder.build(). */
export interface PromptBuildOptions {
  /** Agent name for {{agent_name}}. */
  agentName?: string;
  /** Current provider name for {{provider_name}}. */
  providerName?: string;
  /** Current model name for {{model_name}}. */
  modelName?: string;
  /** Available tool count for {{tool_count}}. */
  toolCount?: number;
  /** MCP instructions to inject. */
  mcpInstructions?: string;
  /** Provider-specific instructions. */
  providerInstructions?: string;
}

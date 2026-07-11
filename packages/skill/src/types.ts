// packages/skill/src/types.ts
import type { Tool, Message } from "@helm/core";

/** Context passed to a skill handler at execution time. */
export interface SkillContext {
  /** All currently registered tools (name → Tool). */
  tools: Map<string, Tool>;
  /** Current conversation history. */
  messages: Message[];
  /** Append a message to the conversation history. */
  addMessage: (msg: Message) => void;
  /** Run ID for journaling. */
  runId: string;
}

/** A skill definition — can be registered from built-in, plugin, or user file. */
export interface Skill {
  /** Skill name (without leading slash). e.g. "help", "my-skill". */
  name: string;
  /** Human-readable description for /help. */
  description: string;
  /** Execute the skill. Returns text to display, or empty string for no output. */
  handler: (input: string, ctx: SkillContext) => Promise<string>;
}

/** Parsed slash-command input. */
export interface ParsedSkillInput {
  /** Skill name (without leading slash). */
  name: string;
  /** Everything after the skill name. */
  input: string;
}

/**
 * Parse a slash-command string into skill name + input.
 * Examples:
 *   "/search helm mcp" → { name: "search", input: "helm mcp" }
 *   "/code-review"     → { name: "code-review", input: "" }
 *   "/help"            → { name: "help", input: "" }
 */
export function parseSkillInput(raw: string): ParsedSkillInput {
  const trimmed = raw.trim();
  // Strip leading /
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  // Split on first whitespace
  const spaceIdx = withoutSlash.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: withoutSlash.toLowerCase(), input: "" };
  }
  return {
    name: withoutSlash.slice(0, spaceIdx).toLowerCase(),
    input: withoutSlash.slice(spaceIdx + 1).trim(),
  };
}

/** Error thrown during skill execution. */
export class SkillError extends Error {
  constructor(
    message: string,
    public readonly skillName: string,
    public readonly cause?: unknown,
  ) {
    super(`[skill:${skillName}] ${message}`);
    this.name = "SkillError";
  }
}

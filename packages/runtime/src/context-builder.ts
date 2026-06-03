import type { Message, ToolDef, ContextWindow } from "@helm/core";
import type { TokenCounter } from "./token-counter.js";
import type { Tool } from "@helm/core";

// ── ContextBuilder ────────────────────────────────────────────────────────

export interface ContextBuilderOptions {
  systemPrompt?: string | null;
  messages: Message[];
  toolDefs: ToolDef[];
}

export class ContextBuilder {
  constructor(private tokenCounter: TokenCounter) {}

  build(options: ContextBuilderOptions): ContextWindow {
    let estimatedTokens = 0;

    if (options.systemPrompt) {
      estimatedTokens += this.tokenCounter.countText(options.systemPrompt);
    }

    estimatedTokens += this.tokenCounter.countMessages(options.messages);

    if (options.toolDefs.length > 0) {
      estimatedTokens += this.tokenCounter.countToolDefs(options.toolDefs);
    }

    return {
      systemPrompt: options.systemPrompt ?? null,
      messages: options.messages,
      toolDefs: options.toolDefs,
      estimatedTokens,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function toToolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

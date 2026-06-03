import type { Message, ToolDef } from "@helm/core";

// ── TokenCounter interface ────────────────────────────────────────────────

export interface TokenCounter {
  countText(text: string): number;
  countMessages(messages: Message[]): number;
  countToolDefs(toolDefs: ToolDef[]): number;
}

// ── CharTokenCounter ──────────────────────────────────────────────────────

const DEFAULT_CHARS_PER_TOKEN = 4;

export class CharTokenCounter implements TokenCounter {
  readonly charsPerToken: number;

  constructor(charsPerToken: number = DEFAULT_CHARS_PER_TOKEN) {
    this.charsPerToken = charsPerToken;
  }

  countText(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / this.charsPerToken));
  }

  countMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.countText(msg.role);
      total += this.countText(msg.content);
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += this.countText(tc.name);
          total += this.countText(JSON.stringify(tc.args));
        }
      }
    }
    return total;
  }

  countToolDefs(toolDefs: ToolDef[]): number {
    let total = 0;
    for (const td of toolDefs) {
      total += this.countText(td.name);
      total += this.countText(td.description);
      total += this.countText(JSON.stringify(td.parameters));
    }
    return total;
  }
}

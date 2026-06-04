import type { Message, ToolDef } from "@helm/core";
import type { TokenCounter } from "@helm/runtime";
// gpt-tokenizer is ESM-only; use dynamic import for vitest compatibility
import { encode, decode } from "gpt-tokenizer";

// ── OpenAITokenCounter ────────────────────────────────────────────────────
//
// Uses the cl100k_base encoding (same as GPT-4 / DeepSeek) via the
// gpt-tokenizer package for accurate token counts.
//
// Tradeoff: gpt-tokenizer is a pure-JS port of tiktoken. It's not
// identical to the API's internal counter but is within ~1-2% accuracy,
// which is sufficient for budget estimation and context window management.

const MODEL_PREFIX = "cl100k_base";

export class OpenAITokenCounter implements TokenCounter {
  countText(text: string): number {
    if (!text) return 0;
    try {
      return encode(text).length;
    } catch {
      // Fallback to character heuristic if encoding fails
      return Math.max(1, Math.ceil(text.length / 4));
    }
  }

  countMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      // Role overhead (~3 tokens per message for formatting)
      total += 3;
      total += this.countText(msg.role);
      total += this.countText(msg.content);
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += this.countText(tc.name);
          total += this.countText(JSON.stringify(tc.args));
        }
      }
    }
    // Every reply is primed with <|start|>assistant<|message|> (~3 tokens)
    total += 3;
    return total;
  }

  countToolDefs(toolDefs: ToolDef[]): number {
    let total = 0;
    for (const td of toolDefs) {
      total += this.countText(td.name);
      total += this.countText(td.description);
      total += this.countText(JSON.stringify(td.parameters));
      // Tool definition overhead (~6 tokens per tool)
      total += 6;
    }
    return total;
  }
}

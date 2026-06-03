import type { Message } from "./provider.js";

// ── ToolDef ───────────────────────────────────────────────────────────────

/** Serializable tool definition for context assembly — the schema a provider
 *  needs to know about a tool, without the execute function. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── ContextWindow ─────────────────────────────────────────────────────────

/** The complete context assembled before a provider call. */
export interface ContextWindow {
  systemPrompt: string | null;
  messages: Message[];
  toolDefs: ToolDef[];
  estimatedTokens: number;
}

// ── TokenBudget ───────────────────────────────────────────────────────────

const DEFAULT_WARN_THRESHOLD = 0.8;

export class TokenBudget {
  private _usedTokens = 0;
  readonly maxTokens: number;
  readonly warnThreshold: number;

  constructor(maxTokens: number, warnThreshold: number = DEFAULT_WARN_THRESHOLD) {
    if (maxTokens <= 0) {
      throw new Error("maxTokens must be positive");
    }
    this.maxTokens = maxTokens;
    this.warnThreshold = warnThreshold;
  }

  get usedTokens(): number {
    return this._usedTokens;
  }

  get remainingTokens(): number {
    return Math.max(0, this.maxTokens - this._usedTokens);
  }

  isExhausted(): boolean {
    return this._usedTokens >= this.maxTokens;
  }

  isWarning(): boolean {
    return this._usedTokens >= this.maxTokens * this.warnThreshold;
  }

  consume(tokens: number): void {
    this._usedTokens += tokens;
  }

  reset(): void {
    this._usedTokens = 0;
  }
}

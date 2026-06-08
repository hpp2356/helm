import type { Message, Provider, ContextWindow } from "@helm/core";
import type { TokenCounter } from "./token-counter.js";
import { ContextBuilder } from "./context-builder.js";
import type { Tool } from "@helm/core";

// ── Types ───────────────────────────────────────────────────────────────────

export type CompactionStrategy = "summarize" | "truncate";

export interface CompactionOptions {
  /** Compaction strategy. Default: "summarize". */
  strategy?: CompactionStrategy;
  /**
   * Provider used to generate summaries (required for "summarize" strategy).
   * Can be the same provider as the main agent loop, or a cheaper/faster one.
   */
  provider?: Provider;
  /** Token counter for estimating context size. */
  tokenCounter: TokenCounter;
  /**
   * Number of recent turns to keep uncompressed.
   * The most recent N turns + the initial user message are always preserved.
   * Default: 2.
   */
  keepRecentTurns?: number;
  /** System prompt to always preserve. */
  systemPrompt?: string | null;
}

export interface CompactionResult {
  /** The compacted message list. */
  messages: Message[];
  /** Whether compaction actually reduced the message count. */
  didCompact: boolean;
  /** Message count before compaction. */
  messageCountBefore: number;
  /** Message count after compaction. */
  messageCountAfter: number;
  /** Estimated tokens before compaction. */
  tokensEstimatedBefore: number;
  /** Estimated tokens after compaction. */
  tokensEstimatedAfter: number;
  /** Human-readable summary (only for "summarize" strategy). */
  summaryText?: string;
}

// ── Turn grouping helpers ───────────────────────────────────────────────────

interface Turn {
  messages: Message[];
}

/**
 * Split a flat message list into turns.
 *
 * A turn is: an assistant message + all its tool result messages.
 * The initial user message (first message) is its own "turn".
 * Each subsequent assistant message starts a new turn.
 */
function splitIntoTurns(messages: Message[]): Turn[] {
  if (messages.length === 0) return [];

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // New assistant message starts a new turn
      currentTurn = { messages: [msg] };
      turns.push(currentTurn);
    } else if (msg.role === "tool" && currentTurn) {
      // Tool result belongs to the current assistant turn
      currentTurn.messages.push(msg);
    } else {
      // User message or any non-tool, non-assistant → its own turn
      currentTurn = { messages: [msg] };
      turns.push(currentTurn);
    }
  }

  return turns;
}

/** Flatten turns back into a message list. */
function turnsToMessages(turns: Turn[]): Message[] {
  return turns.flatMap((t) => t.messages);
}

/** Build a simple context window for token estimation. */
function estimateTokens(
  messages: Message[],
  tokenCounter: TokenCounter,
  toolDefs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  systemPrompt?: string | null,
): number {
  const cb = new ContextBuilder(tokenCounter);
  const window = cb.build({ systemPrompt, messages, toolDefs });
  return window.estimatedTokens;
}

// ── Summary prompt ──────────────────────────────────────────────────────────

function buildSummaryPrompt(messages: Message[]): string {
  const conversation = messages
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls) {
        const calls = m.toolCalls
          .map((tc) => `  ${tc.name}(${JSON.stringify(tc.args)})`)
          .join("\n");
        return `assistant:\n${m.content}\n[Tool calls]:\n${calls}`;
      }
      if (m.role === "tool") {
        const short =
          m.content.length > 200
            ? m.content.slice(0, 200) + "..."
            : m.content;
        return `[tool result]: ${short}`;
      }
      return `${m.role}: ${m.content}`;
    })
    .join("\n\n");

  return `Summarize the following conversation into a concise summary that captures the key information, decisions, and results. Keep it brief but complete — future turns will rely on this summary for context.

Conversation:
${conversation}

Summary:`;
}

// ── Compaction ──────────────────────────────────────────────────────────────

export class Compaction {
  /** The configured compaction strategy (read-only after construction). */
  readonly strategy: CompactionStrategy;
  private provider?: Provider;
  private tokenCounter: TokenCounter;
  private keepRecentTurns: number;
  private systemPrompt: string | null;

  constructor(options: CompactionOptions) {
    this.strategy = options.strategy ?? "summarize";
    this.provider = options.provider;
    this.tokenCounter = options.tokenCounter;
    this.keepRecentTurns = options.keepRecentTurns ?? 2;
    this.systemPrompt = options.systemPrompt ?? null;

    if (this.strategy === "summarize" && !this.provider) {
      throw new Error(
        'Compaction strategy "summarize" requires a provider. ' +
          'Pass { provider } in CompactionOptions, or use strategy: "truncate".',
      );
    }
  }

  /**
   * Compact the message list if needed.
   *
   * @param messages - The current message history.
   * @param tools - Currently registered tools (for token estimation).
   * @param signal - Optional AbortSignal for the summary provider call.
   */
  async compact(
    messages: Message[],
    tools: Tool[],
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const tokensBefore = estimateTokens(
      messages,
      this.tokenCounter,
      toolDefs,
      this.systemPrompt,
    );

    const turns = splitIntoTurns(messages);

    // If there aren't enough turns to bother compacting, skip
    // Need at least: initial user + keepRecentTurns + 1 to compact
    const minTurnsForCompaction = 1 + this.keepRecentTurns + 1;
    if (turns.length < minTurnsForCompaction) {
      return {
        messages,
        didCompact: false,
        messageCountBefore: messages.length,
        messageCountAfter: messages.length,
        tokensEstimatedBefore: tokensBefore,
        tokensEstimatedAfter: tokensBefore,
      };
    }

    // Keep: initial user turn + most recent N turns
    const userTurn = turns[0];
    const recentTurns = turns.slice(-this.keepRecentTurns);
    const middleTurns = turns.slice(1, -this.keepRecentTurns);

    if (middleTurns.length === 0) {
      return {
        messages,
        didCompact: false,
        messageCountBefore: messages.length,
        messageCountAfter: messages.length,
        tokensEstimatedBefore: tokensBefore,
        tokensEstimatedAfter: tokensBefore,
      };
    }

    const middleMessages = turnsToMessages(middleTurns);

    try {
      if (this.strategy === "summarize" && this.provider) {
        return await this.summarizeCompact(
          messages,
          middleMessages,
          userTurn,
          recentTurns,
          toolDefs,
          tokensBefore,
          signal,
        );
      }
      // truncate strategy
      return this.truncateCompact(
        messages,
        userTurn,
        recentTurns,
        toolDefs,
        tokensBefore,
      );
    } catch {
      // Fallback: if summarize fails, try truncate
      if (this.strategy === "summarize") {
        return this.truncateCompact(
          messages,
          userTurn,
          recentTurns,
          toolDefs,
          tokensBefore,
        );
      }
      // Truncate shouldn't fail, but just in case
      return {
        messages,
        didCompact: false,
        messageCountBefore: messages.length,
        messageCountAfter: messages.length,
        tokensEstimatedBefore: tokensBefore,
        tokensEstimatedAfter: tokensBefore,
      };
    }
  }

  private async summarizeCompact(
    originalMessages: Message[],
    middleMessages: Message[],
    userTurn: Turn,
    recentTurns: Turn[],
    toolDefs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    tokensBefore: number,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const summaryPrompt = buildSummaryPrompt(middleMessages);

    const provider = this.provider!;
    let summaryText: string;

    try {
      const response = await provider.send(
        [{ role: "user", content: summaryPrompt }],
        signal,
      );
      summaryText =
        response.content || "[Compaction: unable to generate summary]";
    } catch {
      // Provider call failed — fall back to simple description
      summaryText = `[Compacted ${middleMessages.length} messages from earlier conversation turns]`;
    }

    const summaryMessage: Message = {
      role: "user",
      content: `[Previous conversation summary]\n${summaryText}`,
    };

    const compactedMessages = [
      ...turnsToMessages([userTurn]),
      summaryMessage,
      ...turnsToMessages(recentTurns),
    ];

    const tokensAfter = estimateTokens(
      compactedMessages,
      this.tokenCounter,
      toolDefs,
      this.systemPrompt,
    );

    // Only apply compaction if it actually reduces size
    if (compactedMessages.length >= originalMessages.length) {
      return {
        messages: originalMessages,
        didCompact: false,
        messageCountBefore: originalMessages.length,
        messageCountAfter: originalMessages.length,
        tokensEstimatedBefore: tokensBefore,
        tokensEstimatedAfter: tokensBefore,
      };
    }

    return {
      messages: compactedMessages,
      didCompact: true,
      messageCountBefore: originalMessages.length,
      messageCountAfter: compactedMessages.length,
      tokensEstimatedBefore: tokensBefore,
      tokensEstimatedAfter: tokensAfter,
      summaryText,
    };
  }

  private truncateCompact(
    originalMessages: Message[],
    userTurn: Turn,
    recentTurns: Turn[],
    toolDefs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    tokensBefore: number,
  ): CompactionResult {
    const compactedMessages = [
      ...turnsToMessages([userTurn]),
      {
        role: "user" as const,
        content: `[Earlier conversation truncated — ${this.keepRecentTurns} recent turns kept.]`,
      } as Message,
      ...turnsToMessages(recentTurns),
    ];

    const tokensAfter = estimateTokens(
      compactedMessages,
      this.tokenCounter,
      toolDefs,
      this.systemPrompt,
    );

    if (compactedMessages.length >= originalMessages.length) {
      return {
        messages: originalMessages,
        didCompact: false,
        messageCountBefore: originalMessages.length,
        messageCountAfter: originalMessages.length,
        tokensEstimatedBefore: tokensBefore,
        tokensEstimatedAfter: tokensBefore,
      };
    }

    return {
      messages: compactedMessages,
      didCompact: true,
      messageCountBefore: originalMessages.length,
      messageCountAfter: compactedMessages.length,
      tokensEstimatedBefore: tokensBefore,
      tokensEstimatedAfter: tokensAfter,
    };
  }
}

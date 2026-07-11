// packages/core/src/streaming.ts

/**
 * Streaming events emitted by providers during SSE consumption.
 *
 * These are distinct from RunEvent — RunEvent records turn-level facts
 * for the journal; StreamingEvent captures sub-token deltas for real-time
 * consumer display (REPL, future TUI, etc.).
 */
export type StreamingEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; id: string; name: string; argumentsDelta: string }
  | { type: "thinking_delta"; text: string }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number };

/**
 * Aggregate statistics collected from streaming events.
 */
export interface StreamingStats {
  /** Total text tokens received (character count as proxy). */
  textTokens: number;
  /** Number of tool call deltas received. */
  toolCallDeltas: number;
  /** Total thinking tokens received (character count as proxy). */
  thinkingTokens: number;
  /** Number of text_delta events received. */
  textDeltaCount: number;
  /** Number of tool_call_delta events received. */
  toolCallDeltaCount: number;
  /** Number of thinking_delta events received. */
  thinkingDeltaCount: number;
}

export type StreamingEventHandler = (event: StreamingEvent) => void;

/**
 * Synchronous event bus for streaming events.
 *
 * Providers emit events during SSE consumption; consumers (REPL, journal,
 * eval harness) subscribe. Emit is synchronous — handlers run inline so
 * the REPL can print tokens without buffering.
 *
 * Multiple subscribers are supported. unsubscribe() removes a handler.
 */
export class StreamingBus {
  private handlers: Set<StreamingEventHandler> = new Set();
  private _stats: StreamingStats = {
    textTokens: 0,
    toolCallDeltas: 0,
    thinkingTokens: 0,
    textDeltaCount: 0,
    toolCallDeltaCount: 0,
    thinkingDeltaCount: 0,
  };

  /** Subscribe to streaming events. Returns an unsubscribe function. */
  on(handler: StreamingEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Emit a streaming event to all subscribers. Synchronous. */
  emit(event: StreamingEvent): void {
    this.updateStats(event);
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  /** Current aggregate statistics. */
  get stats(): Readonly<StreamingStats> {
    return this._stats;
  }

  /** Reset all statistics to zero. */
  resetStats(): void {
    this._stats = {
      textTokens: 0,
      toolCallDeltas: 0,
      thinkingTokens: 0,
      textDeltaCount: 0,
      toolCallDeltaCount: 0,
      thinkingDeltaCount: 0,
    };
  }

  /** Number of active subscribers. */
  get listenerCount(): number {
    return this.handlers.size;
  }

  private updateStats(event: StreamingEvent): void {
    switch (event.type) {
      case "text_delta":
        this._stats.textTokens += event.text.length;
        this._stats.textDeltaCount++;
        break;
      case "tool_call_delta":
        this._stats.toolCallDeltas++;
        this._stats.toolCallDeltaCount++;
        break;
      case "thinking_delta":
        this._stats.thinkingTokens += event.text.length;
        this._stats.thinkingDeltaCount++;
        break;
      // turn_start / turn_end — no stats to update
    }
  }
}

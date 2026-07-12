// packages/telemetry/src/traces.ts

import type { SpanEntry } from "./types.js";

/**
 * In-memory traces collector.
 *
 * Manages span lifecycle: start, end, export.
 * Generates trace/span IDs for correlation.
 */
export class TracesCollector {
  private completedSpans: SpanEntry[] = [];
  private activeSpans: Map<string, SpanEntry> = new Map();

  /** Generate a random hex ID (8 chars for span, 16 chars for trace). */
  private generateId(length: number): string {
    const bytes = new Uint8Array(length / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Start a new span. Returns the span ID. */
  startSpan(name: string, traceId?: string, parentSpanId?: string, attributes?: Record<string, unknown>): { traceId: string; spanId: string } {
    const effectiveTraceId = traceId ?? this.generateId(16);
    const spanId = this.generateId(16);

    const span: SpanEntry = {
      name,
      traceId: effectiveTraceId,
      spanId,
      parentSpanId,
      startTime: new Date().toISOString(),
      attributes,
    };

    this.activeSpans.set(spanId, span);
    return { traceId: effectiveTraceId, spanId };
  }

  /** End a span. Moves it to completed list. */
  endSpan(spanId: string, status?: "ok" | "error", errorMessage?: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    const endTime = new Date().toISOString();
    const startTimeMs = new Date(span.startTime).getTime();
    const endTimeMs = new Date(endTime).getTime();

    span.endTime = endTime;
    span.durationMs = endTimeMs - startTimeMs;
    span.status = status ?? "ok";
    span.errorMessage = errorMessage;

    this.activeSpans.delete(spanId);
    this.completedSpans.push(span);
  }

  /** Get and flush all completed spans. */
  flush(): SpanEntry[] {
    const spans = this.completedSpans;
    this.completedSpans = [];
    return spans;
  }

  /** Peek at completed spans. */
  peek(): SpanEntry[] {
    return [...this.completedSpans];
  }

  /** Clear all spans. */
  clear(): void {
    this.completedSpans = [];
    this.activeSpans.clear();
  }
}

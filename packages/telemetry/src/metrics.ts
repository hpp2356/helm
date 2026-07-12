// packages/telemetry/src/metrics.ts

import type { MetricEntry, MetricType } from "./types.js";

/**
 * In-memory metrics collector.
 *
 * Collects counter and histogram metrics, stores them as individual entries.
 * Exporters flush entries periodically.
 */
export class MetricsCollector {
  private entries: MetricEntry[] = [];

  /** Increment a counter metric. */
  increment(name: string, value = 1, labels?: Record<string, string>): void {
    this.entries.push({
      name,
      type: "counter",
      value,
      labels,
      timestamp: new Date().toISOString(),
    });
  }

  /** Record a histogram metric (e.g. duration). */
  record(name: string, value: number, labels?: Record<string, string>): void {
    this.entries.push({
      name,
      type: "histogram",
      value,
      labels,
      timestamp: new Date().toISOString(),
    });
  }

  /** Get and flush all pending entries. */
  flush(): MetricEntry[] {
    const entries = this.entries;
    this.entries = [];
    return entries;
  }

  /** Peek at pending entries without flushing. */
  peek(): MetricEntry[] {
    return [...this.entries];
  }

  /** Clear all pending entries. */
  clear(): void {
    this.entries = [];
  }
}

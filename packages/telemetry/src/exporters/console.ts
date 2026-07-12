// packages/telemetry/src/exporters/console.ts

import type { Exporter, MetricEntry, LogEntry, SpanEntry } from "../types.js";

/**
 * Console exporter — writes telemetry data to stderr.
 * Useful for development and debugging.
 */
export class ConsoleExporter implements Exporter {
  constructor(private prefix = "[telemetry]") {}

  exportMetrics(entries: MetricEntry[]): void {
    for (const entry of entries) {
      const labels = entry.labels ? ` ${JSON.stringify(entry.labels)}` : "";
      process.stderr.write(`${this.prefix} metric ${entry.name}=${entry.value}${labels}\n`);
    }
  }

  exportLogs(entries: LogEntry[]): void {
    for (const entry of entries) {
      const attrs = entry.attributes ? ` ${JSON.stringify(entry.attributes)}` : "";
      const msg = entry.message ? ` — ${entry.message}` : "";
      process.stderr.write(`${this.prefix} ${entry.level} [${entry.event}]${msg}${attrs}\n`);
    }
  }

  exportSpans(entries: SpanEntry[]): void {
    for (const span of entries) {
      const dur = span.durationMs !== undefined ? ` ${span.durationMs}ms` : "";
      process.stderr.write(`${this.prefix} span ${span.name} [${span.traceId}/${span.spanId}]${dur}\n`);
    }
  }

  flush(): void {
    // Console output is immediate, nothing to flush
  }

  shutdown(): void {
    // Nothing to clean up
  }
}

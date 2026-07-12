// packages/telemetry/src/exporters/noop.ts

import type { Exporter, MetricEntry, LogEntry, SpanEntry } from "../types.js";

/** No-op exporter — discards all telemetry data. */
export class NoopExporter implements Exporter {
  exportMetrics(_entries: MetricEntry[]): void {}
  exportLogs(_entries: LogEntry[]): void {}
  exportSpans(_entries: SpanEntry[]): void {}
  flush(): void {}
  shutdown(): void {}
}

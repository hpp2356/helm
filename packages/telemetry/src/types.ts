// packages/telemetry/src/types.ts

/** Metric data point types. */
export type MetricType = "counter" | "histogram";

/** A single metric data point. */
export interface MetricEntry {
  name: string;
  type: MetricType;
  value: number;
  labels?: Record<string, string>;
  timestamp: string;
}

/** Log levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single log entry. */
export interface LogEntry {
  level: LogLevel;
  event: string;
  message?: string;
  attributes?: Record<string, unknown>;
  timestamp: string;
}

/** A single trace span. */
export interface SpanEntry {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  status?: "ok" | "error";
  errorMessage?: string;
}

/** Session usage summary for usage.jsonl. */
export interface UsageEntry {
  session_id: string;
  start_time: string;
  end_time?: string;
  model?: string;
  provider?: string;
  token_input: number;
  token_output: number;
  tool_calls: number;
  tool_errors: number;
  api_requests: number;
  hook_executions: number;
}

/** Telemetry configuration. */
export interface TelemetryConfig {
  /** Whether telemetry is enabled at all. */
  enabled: boolean;
  /** Metrics exporter type. */
  metricsExporter: "console" | "file" | "none";
  /** Logs exporter type. */
  logsExporter: "console" | "file" | "none";
  /** Traces exporter type. */
  tracesExporter: "console" | "file" | "none";
  /** Directory for file exporter. */
  fileExportDir: string;
  /** Whether to log user prompt content. */
  logUserPrompts: boolean;
  /** Whether to log tool output content. */
  logToolContent: boolean;
  /** Verbose mode (log more details). */
  verbose: boolean;
}

/** Exporter interface — all exporters implement this. */
export interface Exporter {
  exportMetrics(entries: MetricEntry[]): void;
  exportLogs(entries: LogEntry[]): void;
  exportSpans(entries: SpanEntry[]): void;
  flush(): void;
  shutdown(): void;
}

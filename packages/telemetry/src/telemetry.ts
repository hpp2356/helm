// packages/telemetry/src/telemetry.ts

import type { TelemetryConfig, Exporter, UsageEntry } from "./types.js";
import { MetricsCollector } from "./metrics.js";
import { LogsCollector } from "./logs.js";
import { TracesCollector } from "./traces.js";
import { ConsoleExporter } from "./exporters/console.js";
import { FileExporter } from "./exporters/file.js";
import { NoopExporter } from "./exporters/noop.js";
import { loadTelemetryConfig } from "./config.js";

/**
 * TelemetryManager — the main orchestrator for observability.
 *
 * Coordinates metrics, logs, and traces collection and export.
 * All operations are non-blocking and never throw.
 */
export class TelemetryManager {
  readonly config: TelemetryConfig;
  readonly metrics: MetricsCollector;
  readonly logs: LogsCollector;
  readonly traces: TracesCollector;
  private metricsExporter: Exporter;
  private logsExporter: Exporter;
  private tracesExporter: Exporter;
  private fileExporter?: FileExporter;
  private sessionStartTime?: string;
  private sessionId?: string;

  constructor(config?: TelemetryConfig) {
    this.config = config ?? loadTelemetryConfig();
    this.metrics = new MetricsCollector();
    this.logs = new LogsCollector(this.config.verbose);
    this.traces = new TracesCollector();

    // Create exporters based on config
    this.metricsExporter = createExporter(this.config.metricsExporter, this.config.fileExportDir);
    this.logsExporter = createExporter(this.config.logsExporter, this.config.fileExportDir);
    this.tracesExporter = createExporter(this.config.tracesExporter, this.config.fileExportDir);

    // Keep a reference to file exporter for usage.jsonl
    if (this.config.metricsExporter === "file" || this.config.logsExporter === "file") {
      this.fileExporter = new FileExporter(this.config.fileExportDir);
    }
  }

  /** Start a session — records start time and session ID. */
  startSession(sessionId: string, model?: string, provider?: string): void {
    this.sessionId = sessionId;
    this.sessionStartTime = new Date().toISOString();
    this.metrics.increment("helm.session.count", 1, { model: model ?? "unknown", provider: provider ?? "unknown" });
    this.logs.info("session:start", `Session ${sessionId} started`, { model, provider });
  }

  /** End a session — records duration and exports usage summary. */
  endSession(): void {
    const endTime = new Date().toISOString();
    if (this.sessionStartTime) {
      const durationMs = new Date(endTime).getTime() - new Date(this.sessionStartTime).getTime();
      this.metrics.record("helm.session.duration", durationMs);
    }
    this.logs.info("session:end", `Session ${this.sessionId} ended`);

    // Export usage summary
    this.exportUsage(endTime);

    // Flush all pending data
    this.flush();
  }

  /** Record an API request. */
  recordApiRequest(durationMs: number, tokenInput?: number, tokenOutput?: number, model?: string): void {
    this.metrics.increment("helm.api.request.count", 1, { model: model ?? "unknown" });
    this.metrics.record("helm.api.request.duration", durationMs, { model: model ?? "unknown" });
    if (tokenInput !== undefined) {
      this.metrics.increment("helm.api.token.input", tokenInput, { model: model ?? "unknown" });
    }
    if (tokenOutput !== undefined) {
      this.metrics.increment("helm.api.token.output", tokenOutput, { model: model ?? "unknown" });
    }
  }

  /** Record a tool call. */
  recordToolCall(toolName: string, durationMs: number, isError = false): void {
    this.metrics.increment("helm.tool.call.count", 1, { tool: toolName });
    this.metrics.record("helm.tool.call.duration", durationMs, { tool: toolName });
    if (isError) {
      this.metrics.increment("helm.tool.call.error", 1, { tool: toolName });
    }
  }

  /** Record a hook execution. */
  recordHookExecute(hookEvent: string, durationMs: number): void {
    this.metrics.increment("helm.hook.execute.count", 1, { event: hookEvent });
    this.logs.debug("hook:execute", `Hook ${hookEvent} executed`, { durationMs });
  }

  /** Flush all pending data to exporters. */
  flush(): void {
    try {
      const metrics = this.metrics.flush();
      if (metrics.length > 0) this.metricsExporter.exportMetrics(metrics);

      const logs = this.logs.flush();
      if (logs.length > 0) this.logsExporter.exportLogs(logs);

      const spans = this.traces.flush();
      if (spans.length > 0) this.tracesExporter.exportSpans(spans);

      this.metricsExporter.flush();
      this.logsExporter.flush();
      this.tracesExporter.flush();
    } catch {
      // Telemetry export failure must never crash Helm
    }
  }

  /** Shutdown — flush remaining data and clean up. */
  shutdown(): void {
    this.flush();
    this.metricsExporter.shutdown();
    this.logsExporter.shutdown();
    this.tracesExporter.shutdown();
  }

  /** Export session usage summary to usage.jsonl. */
  private exportUsage(endTime: string): void {
    if (!this.fileExporter || !this.sessionId) return;

    const metrics = this.metrics.peek();
    const tokenInput = sumMetric(metrics, "helm.api.token.input");
    const tokenOutput = sumMetric(metrics, "helm.api.token.output");
    const toolCalls = sumMetric(metrics, "helm.tool.call.count");
    const toolErrors = sumMetric(metrics, "helm.tool.call.error");
    const apiRequests = sumMetric(metrics, "helm.api.request.count");
    const hookExecutions = sumMetric(metrics, "helm.hook.execute.count");

    const entry: UsageEntry = {
      session_id: this.sessionId,
      start_time: this.sessionStartTime!,
      end_time: endTime,
      token_input: tokenInput,
      token_output: tokenOutput,
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      api_requests: apiRequests,
      hook_executions: hookExecutions,
    };

    try {
      this.fileExporter.exportUsage(entry);
    } catch {
      // Non-fatal
    }
  }
}

/** Create an exporter based on type string. */
function createExporter(type: string, dir: string): Exporter {
  switch (type) {
    case "console":
      return new ConsoleExporter();
    case "file":
      return new FileExporter(dir);
    default:
      return new NoopExporter();
  }
}

/** Sum all values for a given metric name. */
function sumMetric(entries: Array<{ name: string; value: number }>, name: string): number {
  return entries
    .filter((e) => e.name === name)
    .reduce((sum, e) => sum + e.value, 0);
}

// packages/telemetry/src/logs.ts

import type { LogEntry, LogLevel } from "./types.js";

/**
 * In-memory logs collector.
 *
 * Collects log entries at various levels.
 * Exporters flush entries periodically.
 */
export class LogsCollector {
  private entries: LogEntry[] = [];
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /** Log a debug message. Only recorded in verbose mode. */
  debug(event: string, message?: string, attributes?: Record<string, unknown>): void {
    if (!this.verbose) return;
    this.append("debug", event, message, attributes);
  }

  /** Log an info message. */
  info(event: string, message?: string, attributes?: Record<string, unknown>): void {
    this.append("info", event, message, attributes);
  }

  /** Log a warning. */
  warn(event: string, message?: string, attributes?: Record<string, unknown>): void {
    this.append("warn", event, message, attributes);
  }

  /** Log an error. */
  error(event: string, message?: string, attributes?: Record<string, unknown>): void {
    this.append("error", event, message, attributes);
  }

  private append(level: LogLevel, event: string, message?: string, attributes?: Record<string, unknown>): void {
    this.entries.push({
      level,
      event,
      message,
      attributes,
      timestamp: new Date().toISOString(),
    });
  }

  /** Get and flush all pending entries. */
  flush(): LogEntry[] {
    const entries = this.entries;
    this.entries = [];
    return entries;
  }

  /** Peek at pending entries. */
  peek(): LogEntry[] {
    return [...this.entries];
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }
}

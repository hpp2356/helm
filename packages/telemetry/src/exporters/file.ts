// packages/telemetry/src/exporters/file.ts

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Exporter, MetricEntry, LogEntry, SpanEntry, UsageEntry } from "../types.js";

/**
 * File exporter — writes telemetry data to JSONL files.
 *
 * File layout:
 *   <dir>/metrics-YYYY-MM-DD.jsonl
 *   <dir>/logs-YYYY-MM-DD.jsonl
 *   <dir>/traces-YYYY-MM-DD.jsonl
 *   <dir>/usage.jsonl
 */
export class FileExporter implements Exporter {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }
    } catch {
      // Non-fatal — telemetry dir creation failure shouldn't crash Helm
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private appendFile(filename: string, data: string): void {
    try {
      const path = join(this.dir, filename);
      appendFileSync(path, data + "\n", "utf-8");
    } catch {
      // Non-fatal — telemetry write failure shouldn't crash Helm
    }
  }

  exportMetrics(entries: MetricEntry[]): void {
    const filename = `metrics-${this.today()}.jsonl`;
    for (const entry of entries) {
      this.appendFile(filename, JSON.stringify(entry));
    }
  }

  exportLogs(entries: LogEntry[]): void {
    const filename = `logs-${this.today()}.jsonl`;
    for (const entry of entries) {
      this.appendFile(filename, JSON.stringify(entry));
    }
  }

  exportSpans(entries: SpanEntry[]): void {
    const filename = `traces-${this.today()}.jsonl`;
    for (const entry of entries) {
      this.appendFile(filename, JSON.stringify(entry));
    }
  }

  /** Write a session usage summary entry. */
  exportUsage(entry: UsageEntry): void {
    this.appendFile("usage.jsonl", JSON.stringify(entry));
  }

  flush(): void {
    // File writes are immediate via appendFileSync
  }

  shutdown(): void {
    // Nothing to clean up
  }
}

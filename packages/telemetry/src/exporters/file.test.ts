// packages/telemetry/src/exporters/file.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileExporter } from "./file.js";

describe("FileExporter", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-telemetry-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports metrics to daily JSONL file", () => {
    const exporter = new FileExporter(tempDir);
    exporter.exportMetrics([
      { name: "test.counter", type: "counter", value: 5, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const file = join(tempDir, `metrics-${today}.jsonl`);
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe("test.counter");
    expect(parsed.value).toBe(5);
  });

  it("exports logs to daily JSONL file", () => {
    const exporter = new FileExporter(tempDir);
    exporter.exportLogs([
      { level: "info", event: "test", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const file = join(tempDir, `logs-${today}.jsonl`);
    expect(existsSync(file)).toBe(true);
  });

  it("exports spans to daily JSONL file", () => {
    const exporter = new FileExporter(tempDir);
    exporter.exportSpans([
      { name: "span", traceId: "a", spanId: "b", startTime: "2026-01-01T00:00:00Z" },
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const file = join(tempDir, `traces-${today}.jsonl`);
    expect(existsSync(file)).toBe(true);
  });

  it("exports usage to usage.jsonl", () => {
    const exporter = new FileExporter(tempDir);
    exporter.exportUsage({
      session_id: "test-session",
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-01-01T00:30:00Z",
      token_input: 100,
      token_output: 50,
      tool_calls: 3,
      tool_errors: 0,
      api_requests: 2,
      hook_executions: 1,
    });

    const file = join(tempDir, "usage.jsonl");
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.session_id).toBe("test-session");
    expect(parsed.token_input).toBe(100);
  });

  it("appends multiple entries to same file", () => {
    const exporter = new FileExporter(tempDir);
    exporter.exportMetrics([{ name: "a", type: "counter", value: 1, timestamp: "" }]);
    exporter.exportMetrics([{ name: "b", type: "counter", value: 2, timestamp: "" }]);

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(tempDir, `metrics-${today}.jsonl`), "utf-8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
  });
});

// packages/telemetry/src/exporters/console.test.ts

import { describe, it, expect, vi } from "vitest";
import { ConsoleExporter } from "./console.js";

describe("ConsoleExporter", () => {
  it("writes metrics to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exporter = new ConsoleExporter();
    exporter.exportMetrics([
      { name: "test.counter", type: "counter", value: 5, timestamp: "2026-01-01T00:00:00Z" },
    ]);
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("test.counter=5");
    spy.mockRestore();
  });

  it("writes logs to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exporter = new ConsoleExporter();
    exporter.exportLogs([
      { level: "info", event: "test:event", message: "hello", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("info");
    expect(output).toContain("test:event");
    spy.mockRestore();
  });

  it("writes spans to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exporter = new ConsoleExporter();
    exporter.exportSpans([
      { name: "test-span", traceId: "abc", spanId: "def", startTime: "2026-01-01T00:00:00Z", durationMs: 42 },
    ]);
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("test-span");
    expect(output).toContain("42ms");
    spy.mockRestore();
  });

  it("flush and shutdown are no-ops", () => {
    const exporter = new ConsoleExporter();
    exporter.flush();
    exporter.shutdown();
  });
});

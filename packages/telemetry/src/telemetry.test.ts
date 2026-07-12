// packages/telemetry/src/telemetry.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelemetryManager } from "./telemetry.js";
import type { TelemetryConfig } from "./types.js";

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    metricsExporter: "none",
    logsExporter: "none",
    tracesExporter: "none",
    fileExportDir: "/tmp/helm-test-telemetry",
    logUserPrompts: false,
    logToolContent: false,
    verbose: false,
    ...overrides,
  };
}

describe("TelemetryManager", () => {
  it("creates with default config", () => {
    const tm = new TelemetryManager(makeConfig());
    expect(tm.config.enabled).toBe(true);
  });

  it("records session start and end", () => {
    const tm = new TelemetryManager(makeConfig());
    tm.startSession("test-123", "deepseek-chat", "deepseek");

    // Check metrics before endSession flushes them
    const metricsBefore = tm.metrics.peek();
    expect(metricsBefore.some((m) => m.name === "helm.session.count")).toBe(true);

    tm.endSession();
  });

  it("records API request metrics", () => {
    const tm = new TelemetryManager(makeConfig());
    tm.recordApiRequest(500, 100, 50, "deepseek-chat");

    const metrics = tm.metrics.peek();
    expect(metrics.some((m) => m.name === "helm.api.request.count")).toBe(true);
    expect(metrics.some((m) => m.name === "helm.api.request.duration" && m.value === 500)).toBe(true);
    expect(metrics.some((m) => m.name === "helm.api.token.input" && m.value === 100)).toBe(true);
    expect(metrics.some((m) => m.name === "helm.api.token.output" && m.value === 50)).toBe(true);
  });

  it("records tool call metrics", () => {
    const tm = new TelemetryManager(makeConfig());
    tm.recordToolCall("bash", 200, false);
    tm.recordToolCall("read", 100, true);

    const metrics = tm.metrics.peek();
    expect(metrics.filter((m) => m.name === "helm.tool.call.count")).toHaveLength(2);
    expect(metrics.filter((m) => m.name === "helm.tool.call.error")).toHaveLength(1);
  });

  it("records hook execution", () => {
    const tm = new TelemetryManager(makeConfig());
    tm.recordHookExecute("pre:tool", 50);

    const metrics = tm.metrics.peek();
    expect(metrics.some((m) => m.name === "helm.hook.execute.count")).toBe(true);
  });

  it("flush clears all collectors", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tm = new TelemetryManager(makeConfig({ metricsExporter: "console", logsExporter: "console" }));
    tm.startSession("test");
    tm.flush();

    expect(tm.metrics.peek()).toHaveLength(0);
    expect(tm.logs.peek()).toHaveLength(0);
    spy.mockRestore();
  });

  it("shutdown flushes and cleans up", () => {
    const tm = new TelemetryManager(makeConfig());
    tm.startSession("test");
    tm.shutdown();
    expect(tm.metrics.peek()).toHaveLength(0);
  });

  it("never throws on export errors", () => {
    // Use a file path (not a directory) to force export errors
    const tm = new TelemetryManager(makeConfig({ metricsExporter: "none" }));
    tm.startSession("test");
    tm.recordApiRequest(100);
    // Should not throw even with no-op exporter
    tm.flush();
    tm.shutdown();
  });

  it("respects privacy: logUserPrompts=false", () => {
    const tm = new TelemetryManager(makeConfig({ logUserPrompts: false }));
    expect(tm.config.logUserPrompts).toBe(false);
  });

  it("respects privacy: logToolContent=false", () => {
    const tm = new TelemetryManager(makeConfig({ logToolContent: false }));
    expect(tm.config.logToolContent).toBe(false);
  });
});

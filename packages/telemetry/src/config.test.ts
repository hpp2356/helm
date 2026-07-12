// packages/telemetry/src/config.test.ts

import { describe, it, expect } from "vitest";
import { loadTelemetryConfig } from "./config.js";

describe("loadTelemetryConfig", () => {
  it("returns defaults when no env vars set", () => {
    const cfg = loadTelemetryConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.metricsExporter).toBe("none");
    expect(cfg.logsExporter).toBe("none");
    expect(cfg.tracesExporter).toBe("none");
    expect(cfg.logUserPrompts).toBe(false);
    expect(cfg.logToolContent).toBe(false);
    expect(cfg.verbose).toBe(false);
  });

  it("enables telemetry via env var", () => {
    const cfg = loadTelemetryConfig({ HELM_TELEMETRY_ENABLED: "1" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.metricsExporter).toBe("file");
    expect(cfg.logsExporter).toBe("file");
  });

  it("respects exporter overrides", () => {
    const cfg = loadTelemetryConfig({
      HELM_TELEMETRY_ENABLED: "1",
      HELM_METRICS_EXPORTER: "console",
      HELM_LOGS_EXPORTER: "none",
      HELM_TRACES_EXPORTER: "file",
    });
    expect(cfg.metricsExporter).toBe("console");
    expect(cfg.logsExporter).toBe("none");
    expect(cfg.tracesExporter).toBe("file");
  });

  it("enables privacy flags", () => {
    const cfg = loadTelemetryConfig({
      HELM_LOG_USER_PROMPTS: "1",
      HELM_LOG_TOOL_CONTENT: "1",
      HELM_TELEMETRY_VERBOSE: "1",
    });
    expect(cfg.logUserPrompts).toBe(true);
    expect(cfg.logToolContent).toBe(true);
    expect(cfg.verbose).toBe(true);
  });

  it("uses custom telemetry dir", () => {
    const cfg = loadTelemetryConfig({ HELM_TELEMETRY_DIR: "/custom/path" });
    expect(cfg.fileExportDir).toBe("/custom/path");
  });
});

// packages/telemetry/src/config.ts

import type { TelemetryConfig } from "./types.js";

/**
 * Load telemetry configuration from environment variables.
 *
 * Environment variables:
 *   HELM_TELEMETRY_ENABLED    — 1/0 (default: 0)
 *   HELM_METRICS_EXPORTER     — console, file, none (default: none)
 *   HELM_LOGS_EXPORTER        — console, file, none (default: none)
 *   HELM_TRACES_EXPORTER      — console, file, none (default: none)
 *   HELM_TELEMETRY_DIR        — file export directory (default: ~/.helm/telemetry/)
 *   HELM_LOG_USER_PROMPTS     — 1/0 (default: 0)
 *   HELM_LOG_TOOL_CONTENT     — 1/0 (default: 0)
 *   HELM_TELEMETRY_VERBOSE    — 1/0 (default: 0)
 */
export function loadTelemetryConfig(env: Record<string, string | undefined> = process.env): TelemetryConfig {
  const enabled = env.HELM_TELEMETRY_ENABLED === "1";
  const verbose = env.HELM_TELEMETRY_VERBOSE === "1";

  const metricsExporter = parseExporter(env.HELM_METRICS_EXPORTER) ?? (enabled ? "file" : "none");
  const logsExporter = parseExporter(env.HELM_LOGS_EXPORTER) ?? (enabled ? "file" : "none");
  const tracesExporter = parseExporter(env.HELM_TRACES_EXPORTER) ?? "none";

  const home = env.HOME ?? "/tmp";
  const fileExportDir = env.HELM_TELEMETRY_DIR ?? `${home}/.helm/telemetry`;

  return {
    enabled,
    metricsExporter,
    logsExporter,
    tracesExporter,
    fileExportDir,
    logUserPrompts: env.HELM_LOG_USER_PROMPTS === "1",
    logToolContent: env.HELM_LOG_TOOL_CONTENT === "1",
    verbose,
  };
}

function parseExporter(value: string | undefined): "console" | "file" | "none" | undefined {
  if (value === "console" || value === "file" || value === "none") return value;
  return undefined;
}

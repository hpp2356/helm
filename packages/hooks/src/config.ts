// packages/hooks/src/config.ts

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HookConfig, HookEvent, HookRule } from "./types.js";

/**
 * Load hook configuration from layered sources.
 *
 * Lookup order:
 *   1. Project-level: .helm/hooks.json
 *   2. Global-level:  ~/.helm/hooks.json
 *
 * Rules from project-level override global-level for the same event.
 * Rules from different events are merged.
 */
export function loadHookConfig(options: {
  projectRoot?: string;
  homeDir?: string;
}): HookConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? "/tmp";

  const globalConfig = loadSingleConfig(resolve(homeDir, ".helm", "hooks.json"));
  const projectConfig = loadSingleConfig(resolve(projectRoot, ".helm", "hooks.json"));

  // Merge: project overrides global per-event
  const merged: HookConfig = { hooks: {} };
  const allEvents: HookEvent[] = [
    "session:start", "session:end", "user:prompt",
    "pre:tool", "post:tool", "turn:start", "turn:end", "error",
  ];

  for (const event of allEvents) {
    const projectRules = projectConfig.hooks[event];
    const globalRules = globalConfig.hooks[event];
    // Project takes precedence — if project has rules for this event, use them
    if (projectRules && projectRules.length > 0) {
      merged.hooks[event] = projectRules;
    } else if (globalRules && globalRules.length > 0) {
      merged.hooks[event] = globalRules;
    }
  }

  return merged;
}

function loadSingleConfig(filePath: string): HookConfig {
  if (!existsSync(filePath)) {
    return { hooks: {} };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return validateHookConfig(parsed);
  } catch {
    return { hooks: {} };
  }
}

function validateHookConfig(raw: unknown): HookConfig {
  if (!raw || typeof raw !== "object") return { hooks: {} };
  const obj = raw as Record<string, unknown>;
  if (!obj.hooks || typeof obj.hooks !== "object") return { hooks: {} };

  const config: HookConfig = { hooks: {} };
  const validEvents: HookEvent[] = [
    "session:start", "session:end", "user:prompt",
    "pre:tool", "post:tool", "turn:start", "turn:end", "error",
  ];

  for (const [event, rules] of Object.entries(obj.hooks as Record<string, unknown>)) {
    if (!validEvents.includes(event as HookEvent)) continue;
    if (!Array.isArray(rules)) continue;

    const validatedRules: HookRule[] = [];
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const r = rule as Record<string, unknown>;
      if (!Array.isArray(r.handlers)) continue;

      const handlers = r.handlers
        .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
        .filter((h) => h.type === "command" && typeof h.command === "string")
        .map((h) => ({
          type: "command" as const,
          command: h.command as string,
          timeout: typeof h.timeout === "number" ? h.timeout : undefined,
          statusMessage: typeof h.statusMessage === "string" ? h.statusMessage : undefined,
        }));

      if (handlers.length === 0) continue;

      validatedRules.push({
        matcher: typeof r.matcher === "string" ? r.matcher : undefined,
        handlers,
      });
    }

    if (validatedRules.length > 0) {
      config.hooks[event as HookEvent] = validatedRules;
    }
  }

  return config;
}

// packages/hooks/src/runtime.ts

import type {
  HookEvent,
  HookConfig,
  HookInput,
  HookResult,
  HookAggregateResult,
  HookDecision,
} from "./types.js";
import { loadHookConfig } from "./config.js";
import { getMatchingRules } from "./matcher.js";
import { executeHandler } from "./executor.js";
import { TrustRegistry } from "./trust.js";

export interface HookRuntimeOptions {
  /** Project root for .helm/hooks.json. */
  projectRoot?: string;
  /** Home directory for ~/.helm/hooks.json and trust.json. */
  homeDir?: string;
  /** Session ID for hook input. */
  sessionId?: string;
  /** Current working directory for hook input. */
  cwd?: string;
  /** Whether to skip trust checks (--dangerously-bypass-hook-trust). */
  bypassTrust?: boolean;
  /** Disabled hook events (--disable-hook=pre:tool). */
  disabledEvents?: Set<HookEvent>;
  /** Whether all hooks are disabled (--no-hooks). */
  disabled?: boolean;
  /** External abort signal. */
  signal?: AbortSignal;
}

/**
 * Hook runtime — executes lifecycle hooks at key agent events.
 */
export class HookRuntime {
  private config: HookConfig;
  private trust: TrustRegistry;
  private sessionId: string;
  private cwd: string;
  private bypassTrust: boolean;
  private disabledEvents: Set<HookEvent>;
  private disabled: boolean;
  private signal?: AbortSignal;

  constructor(options: HookRuntimeOptions = {}) {
    this.config = loadHookConfig({
      projectRoot: options.projectRoot,
      homeDir: options.homeDir,
    });
    this.trust = new TrustRegistry(options.homeDir);
    this.sessionId = options.sessionId ?? `session_${Date.now()}`;
    this.cwd = options.cwd ?? process.cwd();
    this.bypassTrust = options.bypassTrust ?? false;
    this.disabledEvents = options.disabledEvents ?? new Set();
    this.disabled = options.disabled ?? false;
    this.signal = options.signal;
  }

  /**
   * Execute hooks for a given event.
   *
   * @returns aggregate result, or null if hooks are disabled / no hooks match
   */
  async execute(
    event: HookEvent,
    context: {
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolOutput?: string;
      error?: string;
    } = {},
  ): Promise<HookAggregateResult | null> {
    if (this.disabled) return null;
    if (this.disabledEvents.has(event)) return null;

    const rules = getMatchingRules(this.config, event, context.toolName);
    if (rules.length === 0) return null;

    const input: HookInput = {
      event,
      session_id: this.sessionId,
      tool_name: context.toolName,
      tool_input: context.toolInput,
      tool_output: context.toolOutput,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      error: context.error,
    };

    const results: HookResult[] = [];
    const systemMessages: string[] = [];
    let finalDecision: HookDecision = "allow";
    let denyReason: string | undefined;
    let modifiedInput: Record<string, unknown> | undefined;
    let hadUntrusted = false;

    for (const rule of rules) {
      for (const handler of rule.handlers) {
        // Trust check
        if (!this.bypassTrust && !this.trust.isTrusted(handler.command)) {
          hadUntrusted = true;
          results.push({
            decision: "allow",
            error: `Hook not trusted: ${handler.command}`,
            durationMs: 0,
          });
          continue;
        }

        const result = await executeHandler(handler, input, this.signal);
        results.push(result);

        if (result.systemMessage) {
          systemMessages.push(result.systemMessage);
        }

        // Deny takes precedence
        if (result.decision === "deny" && finalDecision !== "deny") {
          finalDecision = "deny";
          denyReason = result.reason ?? "Hook denied";
        }

        // Modify accumulates (last modify wins)
        if (result.decision === "modify" && result.modifiedInput) {
          if (finalDecision !== "deny") {
            finalDecision = "modify";
          }
          modifiedInput = result.modifiedInput;
        }
      }
    }

    return {
      decision: finalDecision,
      reason: denyReason,
      modifiedInput,
      systemMessages,
      results,
      hadUntrusted,
    };
  }

  /**
   * Check if there are hooks registered for a given event.
   */
  hasHooksFor(event: HookEvent, toolName?: string): boolean {
    if (this.disabled) return false;
    if (this.disabledEvents.has(event)) return false;
    return getMatchingRules(this.config, event, toolName).length > 0;
  }

  /**
   * Get the raw hook config (for inspection/listing).
   */
  getConfig(): HookConfig {
    return this.config;
  }

  /**
   * Get the trust registry (for trust management commands).
   */
  getTrust(): TrustRegistry {
    return this.trust;
  }
}

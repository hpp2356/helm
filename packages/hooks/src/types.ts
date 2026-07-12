// packages/hooks/src/types.ts

/** Hook lifecycle event types. */
export type HookEvent =
  | "session:start"
  | "session:end"
  | "user:prompt"
  | "pre:tool"
  | "post:tool"
  | "turn:start"
  | "turn:end"
  | "error";

/** Decision returned by a hook handler. */
export type HookDecision = "allow" | "deny" | "modify";

/** Input sent to a hook handler via stdin. */
export interface HookInput {
  event: HookEvent;
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  cwd: string;
  timestamp: string;
  error?: string;
}

/** Output received from a hook handler via stdout. */
export interface HookOutput {
  decision?: HookDecision;
  reason?: string;
  modified_input?: Record<string, unknown>;
  system_message?: string;
}

/** A single handler definition within a hook rule. */
export interface HookHandlerDef {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

/** A hook rule: matcher + handlers for a specific event. */
export interface HookRule {
  /** Regex pattern to match tool name. Omitted or "*" matches all. */
  matcher?: string;
  handlers: HookHandlerDef[];
}

/** Hook configuration file schema (.helm/hooks.json). */
export interface HookConfig {
  hooks: Partial<Record<HookEvent, HookRule[]>>;
}

/** Result of executing a single hook handler. */
export interface HookResult {
  /** The decision from the hook (allow/deny/modify). Default: allow. */
  decision: HookDecision;
  /** Reason for deny decision. */
  reason?: string;
  /** Modified tool input (for modify decision). */
  modifiedInput?: Record<string, unknown>;
  /** System message to inject into context. */
  systemMessage?: string;
  /** Whether the hook timed out. */
  timedOut?: boolean;
  /** Whether the hook errored. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

/** Aggregated result from all hooks for a single event. */
export interface HookAggregateResult {
  /** Final decision: deny wins over modify wins over allow. */
  decision: HookDecision;
  /** Reason (from first deny, if any). */
  reason?: string;
  /** Modified input (from last modify, if any). */
  modifiedInput?: Record<string, unknown>;
  /** All system messages from hooks. */
  systemMessages: string[];
  /** Individual hook results for journaling. */
  results: HookResult[];
  /** Whether any hook was skipped due to trust. */
  hadUntrusted?: boolean;
}

/** Trust entry for a hook command. */
export interface TrustEntry {
  command: string;
  hash: string;
  trusted: boolean;
  trustedAt?: string;
}

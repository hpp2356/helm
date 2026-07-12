// packages/hooks/src/index.ts

export { HookRuntime, type HookRuntimeOptions } from "./runtime.js";
export { loadHookConfig } from "./config.js";
export { matchesTool, getMatchingRules } from "./matcher.js";
export { executeHandler } from "./executor.js";
export { TrustRegistry, hashCommand } from "./trust.js";
export type {
  HookEvent,
  HookDecision,
  HookInput,
  HookOutput,
  HookHandlerDef,
  HookRule,
  HookConfig,
  HookResult,
  HookAggregateResult,
  TrustEntry,
} from "./types.js";

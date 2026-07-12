// packages/hooks/src/matcher.ts

import type { HookEvent, HookRule, HookConfig } from "./types.js";

/**
 * Match tool name against a hook rule's matcher pattern.
 *
 * - Omitted or "*" matcher matches all tools
 * - Otherwise, treated as regex pattern
 */
export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // Invalid regex — treat as literal string match
    return matcher === toolName;
  }
}

/**
 * Get all matching hook rules for a given event and optional tool name.
 */
export function getMatchingRules(
  config: HookConfig,
  event: HookEvent,
  toolName?: string,
): HookRule[] {
  const rules = config.hooks[event];
  if (!rules) return [];

  return rules.filter((rule) => {
    // Non-tool events (session:start, turn:start, etc.) don't use matcher
    if (!toolName) return true;
    return matchesTool(rule.matcher, toolName);
  });
}

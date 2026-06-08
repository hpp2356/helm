export enum RiskLevel {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export interface Permission {
  /** Tool name or pattern (trailing * for prefix wildcard) */
  pattern: string;
  riskLevel: RiskLevel;
  description: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

// ── Non-interactive permission policy ───────────────────────────────────

/**
 * Strategy for resolving permission checks in non-interactive mode
 * (no user available to confirm/deny).
 */
export type NonInteractiveStrategy =
  | "auto-approve"
  | "auto-deny"
  | "risk-threshold";

/**
 * Permission policy that defines how the runtime decides allow/deny
 * when no explicit allowlist/denylist rule matches.
 *
 * Policy is only consulted as a fallback — explicit deny rules always
 * take precedence (deny-first), and explicit allow rules always allow.
 */
export interface PermissionPolicy {
  strategy: NonInteractiveStrategy;
  /**
   * Risk threshold for the "risk-threshold" strategy.
   * Tools at or below this level are auto-approved;
   * tools above it (or without a risk level) are auto-denied.
   * Default: MEDIUM.
   */
  riskThreshold?: RiskLevel;
}

/**
 * Options for the {@link PermissionRuntime.check} method,
 * providing additional context for non-interactive policy decisions.
 */
export interface PermissionCheckOptions {
  /** Risk level of the tool being invoked (if known). */
  toolRiskLevel?: RiskLevel;
  /**
   * Non-interactive policy to consult when no explicit rule matches.
   * When omitted, default-deny applies (backward-compatible).
   */
  policy?: PermissionPolicy;
}

/** Risk levels ordered from least to most risky. */
const RISK_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

/**
 * Returns true when `toolRisk` is at or below `threshold`.
 * Tools without a risk level are treated as CRITICAL (conservative).
 */
export function riskAtOrBelow(
  toolRisk: RiskLevel | undefined,
  threshold: RiskLevel,
): boolean {
  const effective = toolRisk ?? RiskLevel.CRITICAL;
  return RISK_ORDER[effective] <= RISK_ORDER[threshold];
}

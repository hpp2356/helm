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

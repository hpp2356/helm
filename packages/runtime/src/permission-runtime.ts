import {
  type Permission,
  type PermissionDecision,
  type PermissionCheckOptions,
  RiskLevel,
  riskAtOrBelow,
} from "@helm/core";

export class PermissionRuntime {
  private allowlist: Permission[] = [];
  private denylist: Permission[] = [];

  allow(permission: Permission): void {
    this.allowlist.push(permission);
  }

  deny(permission: Permission): void {
    this.denylist.push(permission);
  }

  check(
    toolName: string,
    _args: Record<string, unknown>,
    opts?: PermissionCheckOptions,
  ): PermissionDecision {
    // Deny takes precedence — check denylist first (policy cannot override)
    for (const perm of this.denylist) {
      if (this.matchPattern(perm.pattern, toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is denied: ${perm.description} (risk: ${perm.riskLevel})`,
        };
      }
    }

    // Check allowlist — explicit allow always wins
    for (const perm of this.allowlist) {
      if (this.matchPattern(perm.pattern, toolName)) {
        return { allowed: true };
      }
    }

    // No explicit rule — consult policy or default-deny
    const policy = opts?.policy;
    if (!policy) {
      // Default: deny (backward-compatible)
      return {
        allowed: false,
        reason: `Tool "${toolName}" is not in the allowlist`,
      };
    }

    switch (policy.strategy) {
      case "auto-approve":
        return { allowed: true };

      case "auto-deny":
        return {
          allowed: false,
          reason: `Tool "${toolName}" auto-denied (non-interactive: auto-deny)`,
        };

      case "risk-threshold": {
        const threshold = policy.riskThreshold ?? RiskLevel.MEDIUM;
        if (riskAtOrBelow(opts?.toolRiskLevel, threshold)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `Tool "${toolName}" auto-denied (risk ${opts?.toolRiskLevel ?? "unknown"} exceeds threshold ${threshold})`,
        };
      }

      default:
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not in the allowlist`,
        };
    }
  }

  /** Match a pattern against a tool name. Trailing * acts as prefix wildcard. */
  private matchPattern(pattern: string, toolName: string): boolean {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    return pattern === toolName;
  }

  /** List all allowed permissions */
  getAllowed(): Permission[] {
    return [...this.allowlist];
  }

  /** List all denied permissions */
  getDenied(): Permission[] {
    return [...this.denylist];
  }
}

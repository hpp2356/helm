import { type Permission, type PermissionDecision, RiskLevel } from "@helm/core";

export class PermissionRuntime {
  private allowlist: Permission[] = [];
  private denylist: Permission[] = [];

  allow(permission: Permission): void {
    this.allowlist.push(permission);
  }

  deny(permission: Permission): void {
    this.denylist.push(permission);
  }

  check(toolName: string, _args: Record<string, unknown>): PermissionDecision {
    // Deny takes precedence — check denylist first
    for (const perm of this.denylist) {
      if (this.matchPattern(perm.pattern, toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is denied: ${perm.description} (risk: ${perm.riskLevel})`,
        };
      }
    }

    // Check allowlist
    for (const perm of this.allowlist) {
      if (this.matchPattern(perm.pattern, toolName)) {
        return { allowed: true };
      }
    }

    // Default: deny
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the allowlist`,
    };
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

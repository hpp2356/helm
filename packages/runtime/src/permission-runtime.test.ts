import { describe, it, expect } from "vitest";
import { PermissionRuntime } from "./permission-runtime.js";
import { RiskLevel } from "@helm/core";
import type { PermissionPolicy } from "@helm/core";

describe("PermissionRuntime", () => {
  it("allows a registered tool", () => {
    const pr = new PermissionRuntime();
    pr.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo tool" });
    const decision = pr.check("echo", {});
    expect(decision.allowed).toBe(true);
  });

  it("denies an unregistered tool (default-deny)", () => {
    const pr = new PermissionRuntime();
    const decision = pr.check("unknown", {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in the allowlist");
  });

  it("deny overrides allow", () => {
    const pr = new PermissionRuntime();
    pr.allow({ pattern: "rm", riskLevel: RiskLevel.HIGH, description: "remove files" });
    pr.deny({ pattern: "rm", riskLevel: RiskLevel.CRITICAL, description: "block rm" });
    const decision = pr.check("rm", {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("denied");
  });

  it("matches wildcard patterns", () => {
    const pr = new PermissionRuntime();
    pr.allow({ pattern: "file.*", riskLevel: RiskLevel.MEDIUM, description: "file operations" });
    expect(pr.check("file.read", {}).allowed).toBe(true);
    expect(pr.check("file.write", {}).allowed).toBe(true);
    expect(pr.check("file", {}).allowed).toBe(false); // exact match "file" ≠ "file.*"
    expect(pr.check("other.read", {}).allowed).toBe(false);
  });

  it("deny wildcard overrides allow wildcard", () => {
    const pr = new PermissionRuntime();
    pr.allow({ pattern: "file.*", riskLevel: RiskLevel.MEDIUM, description: "file ops" });
    pr.deny({ pattern: "file.delete", riskLevel: RiskLevel.CRITICAL, description: "no delete" });
    expect(pr.check("file.read", {}).allowed).toBe(true);
    expect(pr.check("file.delete", {}).allowed).toBe(false);
  });

  it("lists allowed and denied permissions", () => {
    const pr = new PermissionRuntime();
    pr.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
    pr.deny({ pattern: "rm", riskLevel: RiskLevel.CRITICAL, description: "no rm" });
    expect(pr.getAllowed()).toHaveLength(1);
    expect(pr.getDenied()).toHaveLength(1);
  });

  it("allows matching the most specific deny", () => {
    const pr = new PermissionRuntime();
    pr.deny({ pattern: "fs.*", riskLevel: RiskLevel.HIGH, description: "no fs" });
    // Allow has no matching pattern, so still denied
    pr.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
    expect(pr.check("fs.rm", {}).allowed).toBe(false);
    expect(pr.check("echo", {}).allowed).toBe(true);
  });

  // ── Non-interactive policy tests ────────────────────────────────────

  describe("non-interactive policy", () => {
    const autoApprove: PermissionPolicy = { strategy: "auto-approve" };
    const autoDeny: PermissionPolicy = { strategy: "auto-deny" };
    const riskThreshold: PermissionPolicy = {
      strategy: "risk-threshold",
      riskThreshold: RiskLevel.MEDIUM,
    };

    it("auto-approve allows unregistered tool", () => {
      const pr = new PermissionRuntime();
      const decision = pr.check("unknown", {}, { policy: autoApprove });
      expect(decision.allowed).toBe(true);
    });

    it("auto-approve still respects explicit deny", () => {
      const pr = new PermissionRuntime();
      pr.deny({ pattern: "rm", riskLevel: RiskLevel.CRITICAL, description: "blocked" });
      const decision = pr.check("rm", {}, { policy: autoApprove });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("denied");
    });

    it("auto-approve respects explicit allow (no change)", () => {
      const pr = new PermissionRuntime();
      pr.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
      const decision = pr.check("echo", {}, { policy: autoApprove });
      expect(decision.allowed).toBe(true);
    });

    it("auto-deny denies unregistered tool", () => {
      const pr = new PermissionRuntime();
      const decision = pr.check("unknown", {}, { policy: autoDeny });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("auto-denied");
    });

    it("auto-deny still respects explicit allow", () => {
      const pr = new PermissionRuntime();
      pr.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
      const decision = pr.check("echo", {}, { policy: autoDeny });
      expect(decision.allowed).toBe(true);
    });

    it("risk-threshold allows tool at or below threshold", () => {
      const pr = new PermissionRuntime();
      // No allowlist — rely on policy
      expect(
        pr.check("read", {}, {
          toolRiskLevel: RiskLevel.LOW,
          policy: riskThreshold,
        }).allowed,
      ).toBe(true);
      expect(
        pr.check("write", {}, {
          toolRiskLevel: RiskLevel.MEDIUM,
          policy: riskThreshold,
        }).allowed,
      ).toBe(true);
    });

    it("risk-threshold denies tool above threshold", () => {
      const pr = new PermissionRuntime();
      expect(
        pr.check("bash", {}, {
          toolRiskLevel: RiskLevel.HIGH,
          policy: riskThreshold,
        }).allowed,
      ).toBe(false);
      expect(
        pr.check("bash", {}, {
          toolRiskLevel: RiskLevel.CRITICAL,
          policy: riskThreshold,
        }).allowed,
      ).toBe(false);
    });

    it("risk-threshold denies tool with unknown risk", () => {
      const pr = new PermissionRuntime();
      // No toolRiskLevel → treated as CRITICAL
      const decision = pr.check("unknown", {}, { policy: riskThreshold });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("unknown");
    });

    it("risk-threshold still respects explicit deny (deny-first)", () => {
      const pr = new PermissionRuntime();
      pr.deny({ pattern: "read", riskLevel: RiskLevel.LOW, description: "blocked" });
      // Even though LOW ≤ MEDIUM, explicit deny wins
      const decision = pr.check("read", {}, {
        toolRiskLevel: RiskLevel.LOW,
        policy: riskThreshold,
      });
      expect(decision.allowed).toBe(false);
    });

    it("backward-compatible without policy", () => {
      const pr = new PermissionRuntime();
      // Omitting opts — should still work
      expect(pr.check("unknown", {}).allowed).toBe(false);
      expect(pr.check("unknown", {}).reason).toContain("not in the allowlist");
    });
  });
});

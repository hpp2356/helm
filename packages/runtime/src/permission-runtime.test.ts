import { describe, it, expect } from "vitest";
import { PermissionRuntime } from "./permission-runtime.js";
import { RiskLevel } from "@helm/core";

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
});

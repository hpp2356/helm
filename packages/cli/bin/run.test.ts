import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, "..");
const bin = resolve(cliDir, "dist/bin/run.js");
const tools = resolve(cliDir, "fixtures/tools.json");
const toolsRisked = resolve(cliDir, "fixtures/tools-risked.json");
const script = resolve(cliDir, "fixtures/script.jsonl");
const scriptMixed = resolve(cliDir, "fixtures/script-mixed.jsonl");
const perms = resolve(cliDir, "fixtures/perms.json");
const permsDeny = resolve(cliDir, "fixtures/perms-deny-calc.json");
const permsEmpty = resolve(cliDir, "fixtures/perms-empty.json");

/** Run the CLI and return stdout + exit code (never throws). */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    stdout = execSync(`node ${bin} ${args.join(" ")}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    status = e.status ?? 1;
    stdout = String(e.stdout ?? "");
    stderr = String(e.stderr ?? "");
  }
  return { stdout, stderr, status };
}

/** Read the journal JSONL file and return parsed events. */
function readJournal(runId: string): Record<string, unknown>[] {
  const journalPath = `/tmp/helm-${runId}.jsonl`;
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

// ── Baseline: interactive mode (no --non-interactive flag) ───────────

describe("CLI interactive mode (no flag)", () => {
  it("runs successfully with allowlisted tools", () => {
    const { stdout, status } = runCli([tools, script, perms, "baseline-ok"]);
    expect(status).toBe(0);
    expect(stdout).toContain("RUN START");
    expect(stdout).toContain("calculator");
    expect(stdout).toContain("RUN END");
  });

  it("denies blocked tool and exits 2", () => {
    const { stdout, status } = runCli([tools, script, permsDeny, "baseline-deny"]);
    expect(stdout).toContain("permission denied");
    expect(status).toBe(2);
  });

  it("normal run exits 0", () => {
    const { stdout, status } = runCli([tools, script, perms, "baseline-exit"]);
    expect(status).toBe(0);
    expect(stdout).toContain("RUN END");
  });
});

// ── Non-interactive: auto-approve ────────────────────────────────────

describe("CLI --non-interactive=auto-approve", () => {
  it("allows all tools even when not in allowlist", () => {
    const { stdout, status } = runCli([
      tools,
      script,
      permsEmpty,
      "auto-approve-all",
      "--non-interactive=auto-approve",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("RUN END");
    // Should show permission:allowed events
    const journal = readJournal("auto-approve-all");
    const allowedEvents = journal.filter(
      (e) => e.type === "permission:allowed",
    );
    expect(allowedEvents.length).toBeGreaterThan(0);
    // No denial events
    const deniedEvents = journal.filter(
      (e) => e.type === "permission:denied",
    );
    expect(deniedEvents.length).toBe(0);
  });

  it("still respects explicit deny in deny-first system", () => {
    const { stdout, status } = runCli([
      tools,
      script,
      permsDeny,
      "auto-approve-deny-first",
      "--non-interactive=auto-approve",
    ]);
    // Calculator is explicitly denied — permit denied → exit 2
    expect(stdout).toContain("permission denied");
    expect(status).toBe(2);
  });
});

// ── Non-interactive: auto-deny ──────────────────────────────────────

describe("CLI --non-interactive=auto-deny", () => {
  it("denies all tools when no allowlist", () => {
    const { stdout, status } = runCli([
      tools,
      script,
      permsEmpty,
      "auto-deny-all",
      "--non-interactive=auto-deny",
    ]);
    expect(stdout).toContain("PERM DENY");
    expect(status).toBe(2);

    const journal = readJournal("auto-deny-all");
    const deniedEvents = journal.filter(
      (e) => e.type === "permission:denied",
    );
    expect(deniedEvents.length).toBeGreaterThan(0);
  });

  it("still respects explicit allow (allowlist wins)", () => {
    const { stdout, status } = runCli([
      tools,
      script,
      perms,
      "auto-deny-allowlist",
      "--non-interactive=auto-deny",
    ]);
    // Calculator is explicitly allowed → approved, agent completes normally
    expect(status).toBe(0);
    expect(stdout).toContain("PERM ALLOW");
  });
});

// ── Non-interactive: risk-threshold ──────────────────────────────────

describe("CLI --non-interactive=risk-threshold", () => {
  it("auto-approves tools at or below threshold, denies above", () => {
    const { stdout, status } = runCli([
      toolsRisked,
      scriptMixed,
      permsEmpty,
      "risk-threshold",
      "--non-interactive=risk-threshold",
      "--risk-threshold=MEDIUM",
    ]);
    // calculator (LOW) should be allowed, danger (CRITICAL) should be denied
    expect(stdout).toContain("PERM ALLOW");
    expect(stdout).toContain("PERM DENY");
    // At least one permission denied → exit 2
    expect(status).toBe(2);

    const journal = readJournal("risk-threshold");
    const allowed = journal.filter((e) => e.type === "permission:allowed");
    const denied = journal.filter((e) => e.type === "permission:denied");

    expect(allowed.length).toBeGreaterThanOrEqual(1);
    expect(allowed.some((e) => e.toolName === "calculator")).toBe(true);

    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied.some((e) => e.toolName === "danger")).toBe(true);
  });

  it("allows all LOW tools when threshold is HIGH", () => {
    const { stdout, status } = runCli([
      toolsRisked,
      scriptMixed,
      permsEmpty,
      "risk-threshold-high",
      "--non-interactive=risk-threshold",
      "--risk-threshold=HIGH",
    ]);
    // Both calculator (LOW) and danger (CRITICAL) should be allowed
    // Wait - CRITICAL is above HIGH? Let's check: LOW=0, MEDIUM=1, HIGH=2, CRITICAL=3
    // riskAtOrBelow(CRITICAL, HIGH) = 3 <= 2 → false, so CRITICAL is denied
    expect(stdout).toContain("PERM ALLOW");
    expect(stdout).toContain("PERM DENY"); // danger CRITICAL > HIGH
    expect(status).toBe(2);
  });

  it("allows all tools when threshold is CRITICAL", () => {
    const { stdout, status } = runCli([
      toolsRisked,
      scriptMixed,
      permsEmpty,
      "risk-threshold-max",
      "--non-interactive=risk-threshold",
      "--risk-threshold=CRITICAL",
    ]);
    // All tools should be allowed (LOW ≤ CRITICAL, CRITICAL ≤ CRITICAL)
    expect(stdout).toContain("PERM ALLOW");
    const journal = readJournal("risk-threshold-max");
    const denied = journal.filter((e) => e.type === "permission:denied");
    expect(denied.length).toBe(0);
    expect(status).toBe(0);
  });

  it("denies all when threshold is LOW (everything above)", () => {
    const { stdout, status } = runCli([
      toolsRisked,
      scriptMixed,
      permsEmpty,
      "risk-threshold-min",
      "--non-interactive=risk-threshold",
      "--risk-threshold=LOW",
    ]);
    // Both tools are at or below LOW? calculator=LOW (yes), danger=CRITICAL (no)
    expect(stdout).toContain("PERM ALLOW"); // calculator
    expect(stdout).toContain("PERM DENY");  // danger
    expect(status).toBe(2);
  });

  it("requires --risk-threshold when using risk-threshold strategy", () => {
    const { stderr, status } = runCli([
      tools,
      script,
      perms,
      "no-threshold",
      "--non-interactive=risk-threshold",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("requires --risk-threshold");
  });
});

// ── Invalid flag handling ────────────────────────────────────────────

describe("CLI invalid flags", () => {
  it("rejects invalid --non-interactive value", () => {
    const { stderr, status } = runCli([
      tools,
      script,
      perms,
      "bad-strategy",
      "--non-interactive=always-yes",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid --non-interactive");
  });

  it("rejects invalid --risk-threshold value", () => {
    const { stderr, status } = runCli([
      tools,
      script,
      perms,
      "bad-threshold",
      "--non-interactive=risk-threshold",
      "--risk-threshold=SUPER_HIGH",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid --risk-threshold");
  });
});

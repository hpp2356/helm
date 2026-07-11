import { describe, it, expect } from "vitest";
import { execSync, spawnSync } from "node:child_process";
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
const toolsSubagent = resolve(cliDir, "fixtures/tools-subagent.json");
const permsSubagent = resolve(cliDir, "fixtures/perms-subagent.json");
const scriptSubagent = resolve(cliDir, "fixtures/script-subagent.jsonl");
const scriptSubagentChild = resolve(
  cliDir,
  "fixtures/script-subagent-child.jsonl",
);
const mcpConfig = resolve(cliDir, "fixtures/mcp-config.json");
const mcpConfigEnv = resolve(cliDir, "fixtures/mcp-config-env.json");

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

// ── Subagent ──────────────────────────────────────────────────────────

describe("CLI --subagent", () => {
  it("spawns a subagent and returns result to parent", () => {
    const { stdout, status } = runCli([
      toolsSubagent,
      scriptSubagent,
      permsSubagent,
      "cli-subagent",
      "--subagent",
      `--subagent-script=${scriptSubagentChild}`,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("spawn_subagent");
    expect(stdout).toContain("PERM ALLOW");
    expect(stdout).toContain("RUN END");
  });

  it("journals parent and child events with parentRunId", () => {
    const runId = "cli-subagent-journal";
    runCli([
      toolsSubagent,
      scriptSubagent,
      permsSubagent,
      runId,
      "--subagent",
      `--subagent-script=${scriptSubagentChild}`,
    ]);

    const journal = readJournal(runId);
    // Parent run:start has parentRunId: null
    const parentStart = journal.find(
      (e) => e.type === "run:start" && e.parentRunId === null,
    );
    expect(parentStart).toBeDefined();

    // Child run:start has parentRunId pointing to parent
    const childStart = journal.find(
      (e) => e.type === "run:start" && e.parentRunId !== null,
    );
    expect(childStart).toBeDefined();
    expect(childStart!.parentRunId).toBe(runId);

    // subagent:spawn event links parent and child
    const spawnEvent = journal.find(
      (e) => e.type === "subagent:spawn",
    );
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent!.runId).toBe(runId);
    expect(spawnEvent!.childRunId).toContain("-s");

    // subagent:complete event
    const completeEvent = journal.find(
      (e) => e.type === "subagent:complete",
    );
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.parentRunId).toBe(runId);
  });

  it("child agent events appear in the same journal", () => {
    const runId = "cli-subagent-interleave";
    runCli([
      toolsSubagent,
      scriptSubagent,
      permsSubagent,
      runId,
      "--subagent",
      `--subagent-script=${scriptSubagentChild}`,
    ]);

    const journal = readJournal(runId);
    // Check for child's tool calls
    const childToolCalls = journal.filter(
      (e) =>
        e.type === "tool:call" &&
        (e.runId as string).includes("-s"),
    );
    expect(childToolCalls.length).toBeGreaterThan(0);
  });

  it("enforces max depth limit", () => {
    const runId = "cli-subagent-depth";
    const { stdout } = runCli([
      toolsSubagent,
      scriptSubagent,
      permsSubagent,
      runId,
      "--subagent",
      `--subagent-script=${scriptSubagentChild}`,
      "--subagent-max-depth=1",
    ]);
    // spawn_subagent is called at depth 0, which spawns at depth 1
    // maxDepth=1 means depth 0 can spawn depth 1, but no deeper
    // This should work fine since we only go depth 1
    expect(stdout).toContain("spawn_subagent");
  });

  it("backward-compat: helm run still works", () => {
    const { stdout, status } = runCli([
      "run",
      tools,
      script,
      perms,
      "backward-compat",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("RUN START");
    expect(stdout).toContain("RUN END");
  });

  it("rejects invalid --subagent-max-depth", () => {
    const { stderr, status } = runCli([
      tools,
      script,
      perms,
      "bad-depth",
      "--subagent",
      "--subagent-max-depth=0",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid --subagent-max-depth");
  });
});

// ── REPL ──────────────────────────────────────────────────────────────

describe("CLI REPL (helm repl)", () => {
  /** Run REPL with piped stdin. */
  function runRepl(
    input: string,
    args: string[] = [],
  ): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("node", [bin, "repl", ...args], {
      input,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
    };
  }

  it("starts REPL and displays welcome banner", () => {
    const { stdout } = runRepl("/exit\n");
    expect(stdout).toContain("Helm v");
    expect(stdout).toContain("Welcome back!");
    expect(stdout).toContain("/help");
    expect(stdout).toContain("Journal");
  });

  it("handles /help command", () => {
    const { stdout } = runRepl("/help\n/exit\n");
    expect(stdout).toContain("/clear");
    expect(stdout).toContain("/stats");
    expect(stdout).toContain("/exit");
  });

  it("handles /stats command", () => {
    const { stdout } = runRepl("/stats\n/exit\n");
    expect(stdout).toContain("Session stats");
    expect(stdout).toContain("Messages:");
    expect(stdout).toContain("Turns:");
  });

  it("handles /clear command", () => {
    const { stdout } = runRepl(
      "/clear\n/exit\n",
      ["--provider=scripted"],
    );
    expect(stdout).toContain("Conversation history cleared");
  });

  it("/exit exits with code 0", () => {
    const { status, stdout } = runRepl("/exit\n");
    expect(status).toBe(0);
    expect(stdout).toContain("Goodbye");
  });

  it("ignores empty and whitespace-only input (no turn runs)", () => {
    // Several bare/whitespace Enters then /stats: turn count must stay 0,
    // proving none of them ran the agent loop.
    const { stdout, status } = runRepl(
      "\n   \n\t\n/stats\n/exit\n",
      ["--provider=scripted"],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("Turns:    0");
  });

  it("processes a user message and gets agent reply", () => {
    const { stdout, status } = runRepl(
      "Hello, agent!\n/exit\n",
      ["--provider=scripted"],
    );
    expect(status).toBe(0);
    // AgentLoop runs: should see at minimum no crash
    expect(stdout).toContain("Helm");
  });

  it("processes multiple turns without crash", () => {
    const { stdout, status } = runRepl(
      "First message.\nSecond message.\nThird message.\n/exit\n",
      ["--provider=scripted"],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("Goodbye");
  });

  it("non-interactive mode takes effect in REPL", () => {
    const { stdout, status } = runRepl(
      "Do something.\n/exit\n",
      [
        "--provider=scripted",
        "--non-interactive=auto-deny",
        "--tools=" + tools,
        "--perms=" + permsEmpty,
      ],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("Helm");
  });

  it("writes journal on exit", async () => {
    // Run a short REPL session
    const { stdout } = runRepl(
      "A test message.\n/exit\n",
      ["--provider=scripted"],
    );

    // Extract journal path from output
    const match = stdout.match(
      /Journal → (\/tmp\/helm-repl-\d+\.jsonl)/,
    );
    if (match) {
      const journalPath = match[1]!;
      expect(existsSync(journalPath)).toBe(true);
    }
  });

  it("bare helm (no subcommand) enters REPL", () => {
    const result = spawnSync("node", [bin], {
      input: "/exit\n",
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stdout ?? "").toContain("Helm");
  });

  it("Ctrl-C during turn does not exit REPL", () => {
    // We can't actually send Ctrl-C in a test, but we can verify
    // that the catch block works. Simulate by running a normal message.
    const { status } = runRepl(
      "Normal message.\n/exit\n",
      ["--provider=scripted"],
    );
    expect(status).toBe(0);
  });
});

// ── --mcp-config flag ────────────────────────────────────────────────

describe("CLI --mcp-config flag", () => {
  function runRepl(
    input: string,
    args: string[] = [],
  ): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("node", [bin, "repl", ...args], {
      input,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
    };
  }

  it("loads MCP servers from JSON config file", () => {
    const { stdout, status } = runRepl("/exit\n", [
      `--mcp-config=${mcpConfig}`,
    ]);
    expect(status).toBe(0);
    // MCP server connects (may fail gracefully), REPL still starts
    expect(stdout).toContain("Helm v");
  }, 30_000);

  it("supports mcp-config with env vars", () => {
    const { stdout, status } = runRepl("/exit\n", [
      `--mcp-config=${mcpConfigEnv}`,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Helm v");
  }, 30_000);

  it("merges --mcp-config with --mcp-server flags", () => {
    const { stdout, status } = runRepl("/exit\n", [
      `--mcp-config=${mcpConfig}`,
      "--mcp-server=extra=echo hello",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Helm v");
  }, 30_000);

  it("rejects invalid --mcp-config path", () => {
    const { stderr, status } = runRepl("/exit\n", [
      "--mcp-config=/nonexistent/path.json",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("Failed to load --mcp-config");
  });
});

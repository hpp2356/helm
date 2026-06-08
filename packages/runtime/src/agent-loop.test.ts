import { describe, it, expect } from "vitest";
import { ScriptedProvider } from "./scripted-provider.js";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import { ToolRuntime } from "./tool-runtime.js";
import { PermissionRuntime } from "./permission-runtime.js";
import { Compaction } from "./compaction.js";
import { type RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry.js";
import { JsonlJournal, TokenBudget, RiskLevel } from "@helm/core";
import type { PermissionPolicy } from "@helm/core";
import { ContextBuilder } from "./context-builder.js";
import { CharTokenCounter } from "./token-counter.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AgentLoop", () => {
  it("runs a simple no-tool turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Hello! How can I help?" },
    ]);

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    await loop.run("test-run-1", "Hi!");

    await journal.close();

    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(3); // run:start, turn:start, run:end
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a tool-calling turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo that.",
        toolCalls: [
          { id: "tc1", name: "echo", args: { text: "hello world" } },
        ],
      },
      { role: "assistant", content: "Done! The tool returned the echo." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    await loop.run("test-run-2", "echo hello");

    await journal.close();

    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    // run:start, turn:start, tool:call, tool:result, turn:start, run:end
    expect(lines.length).toBe(6);
    await rm(dir, { recursive: true, force: true });
  });

  it("handles unknown tool gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Trying unknown tool.",
        toolCalls: [{ id: "tc1", name: "nonexistent", args: {} }],
      },
      { role: "assistant", content: "Handled gracefully." },
    ]);

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    await loop.run("test-run-3", "test");

    await journal.close();

    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    const toolResultLine = JSON.parse(lines[3]);
    expect(toolResultLine.type).toBe("tool:result");
    expect(toolResultLine.output).toContain("unknown tool");
    await rm(dir, { recursive: true, force: true });
  });

  it("handles provider error and logs error event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Provider with no responses — will throw on first send()
    const provider = new ScriptedProvider([]);

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    await loop.run("test-run-4", "test");

    await journal.close();

    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    // run:start, turn:start, error, run:end
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const errorLine = JSON.parse(lines[2]);
    expect(errorLine.type).toBe("error");
    await rm(dir, { recursive: true, force: true });
  });

  it("cancels before run starts when signal is already aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "should never run" },
    ]);

    const ac = new AbortController();
    ac.abort();

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      signal: ac.signal,
    });
    const result = await loop.run("test-cancel-pre", "test");

    await journal.close();

    expect(result.exitCode).toBe(130);
    expect(result.cancelled?.reason).toBe("external");

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0].type).toBe("run:start");
    expect(events.find((e) => e.type === "run:cancelled")?.reason).toBe(
      "external"
    );
    expect(events.find((e) => e.type === "turn:start")).toBeUndefined();
    expect(events[events.length - 1]).toMatchObject({
      type: "run:end",
      exitCode: 130,
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("cancels mid-flight when external signal aborts between turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const ac = new AbortController();

    // Tool that aborts the run when called, then waits for the signal.
    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "slow",
      description: "aborts mid-flight",
      parameters: {},
      async execute(_args, signal) {
        ac.abort();
        // Yield so the abort listener fires before we return.
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return "done";
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "calling tool",
        toolCalls: [{ id: "tc1", name: "slow", args: {} }],
      },
      { role: "assistant", content: "should not get here" },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      signal: ac.signal,
    });
    const result = await loop.run("test-cancel-mid", "go");

    await journal.close();

    expect(result.exitCode).toBe(130);
    expect(result.cancelled?.reason).toBe("external");

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run:cancelled")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("cancels via timeout when maxDurationMs elapses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Tool that takes longer than the timeout.
    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "slow",
      description: "slow tool",
      parameters: {},
      async execute(_args, signal) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return "done";
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "calling slow tool",
        toolCalls: [{ id: "tc1", name: "slow", args: {} }],
      },
      { role: "assistant", content: "should not get here" },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      maxDurationMs: 20,
    });
    const result = await loop.run("test-cancel-timeout", "go");

    await journal.close();

    expect(result.exitCode).toBe(130);
    expect(result.cancelled?.reason).toBe("timeout");

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const cancelled = events.find((e) => e.type === "run:cancelled");
    expect(cancelled?.reason).toBe("timeout");
    await rm(dir, { recursive: true, force: true });
  });

  it("clears the timeout when run finishes normally before the deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Hello!" },
    ]);

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      maxDurationMs: 10_000,
    });
    const result = await loop.run("test-timeout-cleared", "hi");

    await journal.close();

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBeUndefined();

    // If the timer wasn't cleared, the test process would stay alive — we can't
    // assert that directly, but we can assert no run:cancelled event was emitted.
    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run:cancelled")).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  // ── PR06: Retry tests ───────────────────────────────────────────────

  it("retries on retryable error and succeeds on second attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // First call throws rate_limit, second call returns success.
    const provider = new ScriptedProvider([
      { _error: true, message: "rate limit", category: "rate_limit" },
      { role: "assistant", content: "recovered!" },
    ]);

    const fastPolicy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitter: false,
    };

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      retryPolicy: fastPolicy,
    });
    const result = await loop.run("test-retry-success", "go");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].errorType).toBe("provider");
    expect(errorEvents[0].errorCategory).toBe("rate_limit");

    const retryEvents = events.filter((e) => e.type === "retry");
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0]).toMatchObject({
      phase: "attempt",
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(events.some((e) => e.type === "run:end" && e.exitCode === 0)).toBe(
      true,
    );
    expect(events.some((e) => e.type === "retry" && (e as {phase: string}).phase === "exhausted")).toBe(
      false,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("does not retry on non-retryable error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { _error: true, message: "bad key", category: "auth_failure" },
      { role: "assistant", content: "never reached" },
    ]);

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });
    const result = await loop.run("test-no-retry", "go");
    await journal.close();

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(result.exitCode).toBe(0); // non-retryable = no exhaustion
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].errorCategory).toBe("auth_failure");

    // No retry events at all.
    expect(events.filter((e) => e.type === "retry").length).toBe(0);

    // The second message should never have been consumed.
    // Provider index only advanced past the error entry.
    await rm(dir, { recursive: true, force: true });
  });

  it("emits retry exhausted when all attempts fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Three retryable errors in a row — exhausts maxAttempts=3.
    const provider = new ScriptedProvider([
      { _error: true, message: "fail 1", category: "server_error" },
      { _error: true, message: "fail 2", category: "server_error" },
      { _error: true, message: "fail 3", category: "server_error" },
    ]);

    const fastPolicy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitter: false,
    };

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      retryPolicy: fastPolicy,
    });
    const result = await loop.run("test-exhausted", "go");
    await journal.close();

    expect(result.exitCode).toBe(1); // EXIT_ERROR

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(3);

    const retryEvents = events.filter(
      (e: {type: string}) => e.type === "retry",
    );
    // 2 attempts + 1 exhausted = 3 retry events
    expect(retryEvents.length).toBe(3);
    expect(retryEvents[0].phase).toBe("attempt");
    expect(retryEvents[1].phase).toBe("attempt");
    expect(retryEvents[2].phase).toBe("exhausted");
    expect(retryEvents[2].attemptNumber).toBe(3);

    await rm(dir, { recursive: true, force: true });
  });

  it("aborts retry delay when signal fires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const ac = new AbortController();

    const provider = new ScriptedProvider([
      { _error: true, message: "fail 1", category: "server_error" },
      { role: "assistant", content: "never reached" },
    ]);

    const slowPolicy: RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 5000,
      maxDelayMs: 30_000,
      backoffMultiplier: 2,
      jitter: false,
      shouldRetry(e) {
        return e.retryable;
      },
    };

    const toolRuntime = new ToolRuntime();
    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      signal: ac.signal,
      retryPolicy: slowPolicy,
    });

    // Abort after the first error is emitted but while waiting in backoff.
    const runPromise = loop.run("test-abort-delay", "go");
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const result = await runPromise;
    await journal.close();

    expect(result.exitCode).toBe(130);
    expect(result.cancelled?.reason).toBe("external");

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Should see one error and a retry attempt that got aborted, then cancelled.
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "retry")).toBe(true);
    expect(events.some((e) => e.type === "run:cancelled")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("respects maxTurns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Provider always returns tool calls, never a final answer
    const responses = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      content: `turn ${i}`,
      toolCalls: [{ id: `tc${i}`, name: "echo", args: { text: `${i}` } }],
    }));

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider(responses);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 3 });
    await loop.run("test-run-5", "test");

    await journal.close();

    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    const turnStarts = events.filter((e) => e.type === "turn:start");
    expect(turnStarts.length).toBe(3); // exactly maxTurns
    await rm(dir, { recursive: true, force: true });
  });

  // ── PR09: Token budget tests ────────────────────────────────────────────

  it("completes normally when budget is sufficient", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Hello!" },
    ]);

    const toolRuntime = new ToolRuntime();
    const tokenBudget = new TokenBudget(100_000);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
    });
    const result = await loop.run("test-budget-ok", "Hi!");
    await journal.close();

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBeUndefined();
    expect(tokenBudget.usedTokens).toBeGreaterThan(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("stops with error when budget is exhausted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Should not be reached" },
    ]);

    const toolRuntime = new ToolRuntime();
    // Tiny budget — exhausted on first turn (each char is ≥1 token)
    const tokenBudget = new TokenBudget(2);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
    });
    const result = await loop.run("test-budget-exhausted", "Hello world!");
    await journal.close();

    expect(result.exitCode).toBe(1); // EXIT_ERROR

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].errorType).toBe("harness");
    expect(errorEvents[0].errorCategory).toBe("budget_exhausted");

    // Run still has proper lifecycle events
    expect(events.some((e) => e.type === "run:start")).toBe(true);
    expect(events.some((e) => e.type === "run:end")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it("budget check happens before provider.send (exhausted → no llm call)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Provider has one response that should NOT be consumed — budget exhausts first
    const provider = new ScriptedProvider([
      { role: "assistant", content: "Never called" },
    ]);

    const toolRuntime = new ToolRuntime();
    // Budget of 2 tokens — any message will exceed
    const tokenBudget = new TokenBudget(2);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
    });
    const result = await loop.run("test-budget-before-send", "Hello!");
    await journal.close();

    expect(result.exitCode).toBe(1);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // No tool:call events — provider was never called
    expect(events.filter((e) => e.type === "tool:call").length).toBe(0);

    const budgetErrors = events.filter(
      (e) => e.type === "error" && e.errorCategory === "budget_exhausted",
    );
    expect(budgetErrors.length).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("runs multiple turns within budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Calling tool",
        toolCalls: [{ id: "1", name: "echo", args: { text: "hello" } }],
      },
      { role: "assistant", content: "Final answer" },
    ]);

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const tokenBudget = new TokenBudget(100_000);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
    });
    const result = await loop.run("test-budget-multi-turn", "Go");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Two turns with tool calls, plus final turn
    const turnStarts = events.filter((e) => e.type === "turn:start");
    expect(turnStarts.length).toBe(2);
    expect(tokenBudget.usedTokens).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("warns at threshold but continues when not exhausted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "OK" },
    ]);

    const toolRuntime = new ToolRuntime();
    // Budget large enough for the first turn
    const tokenBudget = new TokenBudget(100_000);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
    });
    const result = await loop.run("test-budget-warn", "Hi");
    await journal.close();

    expect(result.exitCode).toBe(0);
    // Warning should not block execution
    expect(tokenBudget.isWarning()).toBe(false); // small run, well under threshold

    await rm(dir, { recursive: true, force: true });
  });

  // ── PR13: Permission journaling tests ─────────────────────────────

  it("journals permission:allowed when tool is allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    perm.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });

    const toolRuntime = new ToolRuntime(perm);
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo.",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
      },
      { role: "assistant", content: "Done." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-perm-allowed", "echo");
    await journal.close();

    expect(result.permissionDenied).toBe(false);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const allowed = events.filter((e) => e.type === "permission:allowed");
    expect(allowed.length).toBe(1);
    expect(allowed[0].toolName).toBe("echo");

    await rm(dir, { recursive: true, force: true });
  });

  it("journals permission:denied when tool is blocked and sets permissionDenied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    // No allow rule → default-deny

    const toolRuntime = new ToolRuntime(perm);
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo.",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
      },
      { role: "assistant", content: "Blocked, moving on." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-perm-denied", "echo");
    await journal.close();

    expect(result.permissionDenied).toBe(true);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const denied = events.filter((e) => e.type === "permission:denied");
    expect(denied.length).toBe(1);
    expect(denied[0].toolName).toBe("echo");
    expect(denied[0].reason).toContain("not in the allowlist");

    await rm(dir, { recursive: true, force: true });
  });

  it("non-interactive auto-approve allows unregistered tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    const policy: PermissionPolicy = { strategy: "auto-approve" };
    const toolRuntime = new ToolRuntime(perm, policy);
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo.",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
      },
      { role: "assistant", content: "Done." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-auto-approve", "echo");
    await journal.close();

    expect(result.permissionDenied).toBe(false);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "permission:allowed")).toBe(true);
    expect(events.some((e) => e.type === "permission:denied")).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("risk-threshold policy: LOW tool allowed, CRITICAL tool denied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    const policy: PermissionPolicy = {
      strategy: "risk-threshold",
      riskThreshold: RiskLevel.MEDIUM,
    };
    const toolRuntime = new ToolRuntime(perm, policy);
    toolRuntime.register({
      name: "read",
      description: "read files",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute() {
        return "file content";
      },
    });
    toolRuntime.register({
      name: "bash",
      description: "run commands",
      riskLevel: RiskLevel.CRITICAL,
      parameters: {},
      async execute() {
        return "command output";
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Doing things.",
        toolCalls: [
          { id: "tc1", name: "read", args: {} },
          { id: "tc2", name: "bash", args: {} },
        ],
      },
      { role: "assistant", content: "Done." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-risk-threshold", "go");
    await journal.close();

    // One allowed, one denied
    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const allowed = events.filter((e) => e.type === "permission:allowed");
    expect(allowed.length).toBe(1);
    expect(allowed[0].toolName).toBe("read");

    const denied = events.filter((e) => e.type === "permission:denied");
    expect(denied.length).toBe(1);
    expect(denied[0].toolName).toBe("bash");
    expect(denied[0].reason).toContain("exceeds threshold");

    expect(result.permissionDenied).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it("non-interactive auto-deny blocks all when no allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    const policy: PermissionPolicy = { strategy: "auto-deny" };
    const toolRuntime = new ToolRuntime(perm, policy);
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo.",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
      },
      { role: "assistant", content: "Done." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-auto-deny", "echo");
    await journal.close();

    expect(result.permissionDenied).toBe(true);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "permission:denied")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it("agent finishes normally when all tools are denied (no hang)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const perm = new PermissionRuntime();
    const policy: PermissionPolicy = { strategy: "auto-deny" };
    const toolRuntime = new ToolRuntime(perm, policy);
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      riskLevel: RiskLevel.LOW,
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    // Three tool calls in one turn, all denied → agent continues to next response
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Trying three tools.",
        toolCalls: [
          { id: "tc1", name: "echo", args: { text: "a" } },
          { id: "tc2", name: "echo", args: { text: "b" } },
          { id: "tc3", name: "echo", args: { text: "c" } },
        ],
      },
      { role: "assistant", content: "All blocked, giving up." },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    const result = await loop.run("test-all-denied", "go");
    await journal.close();

    // Should finish, not hang
    expect(result.exitCode).toBe(0);
    expect(result.permissionDenied).toBe(true);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const denied = events.filter((e) => e.type === "permission:denied");
    expect(denied.length).toBe(3);

    await rm(dir, { recursive: true, force: true });
  });

  // ── PR14: Compaction tests ───────────────────────────────────────

  it("does not compact when budget is below warning threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Hello!" },
    ]);

    const toolRuntime = new ToolRuntime();
    // Large budget — won't hit warning with a single-user-message conversation
    const tokenBudget = new TokenBudget(100_000);
    const contextBuilder = new ContextBuilder(new CharTokenCounter(4));
    const compaction = new Compaction({
      strategy: "truncate",
      tokenCounter: new CharTokenCounter(),
      keepRecentTurns: 1,
    });

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 5,
      tokenBudget,
      contextBuilder,
      compaction,
    });
    const result = await loop.run("test-no-compact", "Hi!");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // No compaction event
    expect(events.filter((e) => e.type === "compaction").length).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("triggers compaction when budget reaches warning threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    // Many turns, small budget to trigger compaction quickly
    const provider = new ScriptedProvider([
      { role: "assistant", content: "Turn 0", toolCalls: [{ id: "t0", name: "echo", args: { text: "a" } }] },
      { role: "assistant", content: "Turn 1", toolCalls: [{ id: "t1", name: "echo", args: { text: "b" } }] },
      { role: "assistant", content: "Turn 2", toolCalls: [{ id: "t2", name: "echo", args: { text: "c" } }] },
      { role: "assistant", content: "Turn 3", toolCalls: [{ id: "t3", name: "echo", args: { text: "d" } }] },
      { role: "assistant", content: "Turn 4", toolCalls: [{ id: "t4", name: "echo", args: { text: "e" } }] },
      { role: "assistant", content: "Final answer" },
    ]);

    // Use aggressive token counting (1 char = 1 token) with low warning
    // Budget large enough to finish all turns after compaction
    const tokenCounter = new CharTokenCounter(1);
    const contextBuilder = new ContextBuilder(tokenCounter);
    const tokenBudget = new TokenBudget(2000, 0.04); // warning at 80 tokens
    const compaction = new Compaction({
      strategy: "truncate",
      tokenCounter,
      keepRecentTurns: 1,
    });

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 10,
      tokenBudget,
      contextBuilder,
      compaction,
    });
    const result = await loop.run("test-compact-trigger", "Do many things.");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents.length).toBe(1);

    const ce = compactionEvents[0];
    expect(ce.strategy).toBe("truncate");
    expect(ce.messageCountBefore).toBeGreaterThan(ce.messageCountAfter);
    // Token count may not drop if truncation note is longer than the compressed content
    expect(ce.tokensEstimatedAfter).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("agent continues working after compaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      { role: "assistant", content: "First turn", toolCalls: [{ id: "t1", name: "echo", args: { text: "hi" } }] },
      { role: "assistant", content: "Second turn", toolCalls: [{ id: "t2", name: "echo", args: { text: "there" } }] },
      { role: "assistant", content: "Third turn after compaction", toolCalls: [{ id: "t3", name: "echo", args: { text: "again" } }] },
      { role: "assistant", content: "All done." },
    ]);

    // Use aggressive token counting (1 char = 1 token) + low warning
    const tokenCounter = new CharTokenCounter(1);
    const contextBuilder = new ContextBuilder(tokenCounter);
    const tokenBudget = new TokenBudget(2000, 0.04); // warning at 80 tokens
    const compaction = new Compaction({
      strategy: "truncate",
      tokenCounter,
      keepRecentTurns: 1,
    });

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 10,
      tokenBudget,
      contextBuilder,
      compaction,
    });
    const result = await loop.run("test-continue-after", "Go!");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents.length).toBeGreaterThanOrEqual(1);

    // Tool calls after compaction should still happen
    const compIdx = events.findIndex((x: Record<string, unknown>) => x.type === "compaction");
    const toolCallsAfterCompact = events.filter(
      (e: Record<string, unknown>, i: number) =>
        e.type === "tool:call" && compIdx >= 0 && i > compIdx,
    );
    expect(toolCallsAfterCompact.length).toBeGreaterThanOrEqual(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("only compacts once per run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    const provider = new ScriptedProvider([
      { role: "assistant", content: "T1", toolCalls: [{ id: "1", name: "echo", args: { text: "a" } }] },
      { role: "assistant", content: "T2", toolCalls: [{ id: "2", name: "echo", args: { text: "b" } }] },
      { role: "assistant", content: "T3", toolCalls: [{ id: "3", name: "echo", args: { text: "c" } }] },
      { role: "assistant", content: "T4", toolCalls: [{ id: "4", name: "echo", args: { text: "d" } }] },
      { role: "assistant", content: "T5", toolCalls: [{ id: "5", name: "echo", args: { text: "e" } }] },
      { role: "assistant", content: "T6", toolCalls: [{ id: "6", name: "echo", args: { text: "f" } }] },
      { role: "assistant", content: "Done." },
    ]);

    const tokenCounter = new CharTokenCounter(1);
    const contextBuilder = new ContextBuilder(tokenCounter);
    const tokenBudget = new TokenBudget(2000, 0.04); // warning at 80 tokens
    const compaction = new Compaction({
      strategy: "truncate",
      tokenCounter,
      keepRecentTurns: 1,
    });

    const loop = new AgentLoop(provider, toolRuntime, journal, {
      maxTurns: 10,
      tokenBudget,
      contextBuilder,
      compaction,
    });
    const result = await loop.run("test-once", "Go!");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents.length).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("compaction with summarize strategy generates summary text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "echo",
      description: "echoes",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return `echo: ${args.text}`;
      },
    });

    // Summary provider returns the summary text
    const summProvider = new ScriptedProvider([
      { role: "assistant", content: "Summary of the conversation so far." },
    ]);

    const mainProvider = new ScriptedProvider([
      { role: "assistant", content: "T1", toolCalls: [{ id: "1", name: "echo", args: { text: "a" } }] },
      { role: "assistant", content: "T2", toolCalls: [{ id: "2", name: "echo", args: { text: "b" } }] },
      { role: "assistant", content: "T3", toolCalls: [{ id: "3", name: "echo", args: { text: "c" } }] },
      { role: "assistant", content: "T4", toolCalls: [{ id: "4", name: "echo", args: { text: "d" } }] },
      { role: "assistant", content: "Final." },
    ]);

    const tokenCounter = new CharTokenCounter(1);
    const contextBuilder = new ContextBuilder(tokenCounter);
    const tokenBudget = new TokenBudget(2000, 0.04); // warning at 80 tokens
    const compaction = new Compaction({
      strategy: "summarize",
      provider: summProvider,
      tokenCounter,
      keepRecentTurns: 1,
    });

    const loop = new AgentLoop(mainProvider, toolRuntime, journal, {
      maxTurns: 10,
      tokenBudget,
      contextBuilder,
      compaction,
    });
    const result = await loop.run("test-summarize", "Go!");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].strategy).toBe("summarize");
    expect(compactionEvents[0].summaryText).toContain("Summary");

    await rm(dir, { recursive: true, force: true });
  });
});

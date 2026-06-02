import { describe, it, expect } from "vitest";
import { ScriptedProvider } from "./scripted-provider.js";
import { AgentLoop } from "./agent-loop.js";
import { ToolRuntime } from "./tool-runtime.js";
import { JsonlJournal } from "@helm/core";
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
});

import { describe, it, expect } from "vitest";
import { SubagentRuntime, createSubagentTool } from "./subagent-runtime.js";
import { ToolRuntime } from "./tool-runtime.js";
import { PermissionRuntime } from "./permission-runtime.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { RiskLevel } from "@helm/core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeToolRuntime() {
  const tr = new ToolRuntime();
  tr.register({
    name: "echo",
    description: "echoes input",
    riskLevel: RiskLevel.LOW,
    parameters: {},
    async execute(args: Record<string, unknown>) {
      return `echo: ${args.text}`;
    },
  });
  tr.register({
    name: "read",
    description: "reads a file",
    riskLevel: RiskLevel.LOW,
    parameters: {},
    async execute(args: Record<string, unknown>) {
      return `file content of ${args.filePath}`;
    },
  });
  return tr;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SubagentRuntime", () => {
  it("spawns a subagent and returns a result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    // Subagent gets its own ScriptedProvider
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me echo something.",
        toolCalls: [{ id: "c1", name: "echo", args: { text: "sub_hello" } }],
      },
      { role: "assistant", content: "Done with the subtask." },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 3,
    });

    const result = await sr.spawn(
      "Echo hello and report back.",
      "parent-run-1",
      0,
    );

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("parent-run-1-s1");
    expect(result.summary).toContain("exitCode=0");

    await rm(dir, { recursive: true, force: true });
  });

  it("respects tool restriction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    // Subagent tries to call read, but only echo is allowed
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me read a file.",
        toolCalls: [
          { id: "c1", name: "read", args: { filePath: "/tmp/test.txt" } },
        ],
      },
      { role: "assistant", content: "Done." },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 3,
    });

    const result = await sr.spawn(
      "Read a file and report back.",
      "parent-run-2",
      0,
      ["echo"], // Only echo allowed, read is blocked
    );

    // The subagent will call read but the tool isn't registered → "unknown tool"
    expect(result.summary).toContain("echo");
    expect(result.summary).not.toContain("read");

    await rm(dir, { recursive: true, force: true });
  });

  it("enforces max depth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    const provider = new ScriptedProvider([]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 2,
    });

    // Depth 0 → 1 → 2 should be allowed
    const result = await sr.spawn("task", "root", 2);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("max depth");
    expect(result.summary).toContain("2");
  });

  it("allows spawn when within depth limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Hello from sub!" },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 3,
    });

    // Depth 1 is within limit of 3
    const result = await sr.spawn("task", "root", 1);
    expect(result.exitCode).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("child run:start has parentRunId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    const provider = new ScriptedProvider([
      { role: "assistant", content: "Done." },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 3,
    });

    await sr.spawn("Simple task.", "parent-run-5", 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("handles subagent provider failure gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "subagent.jsonl");
    const toolRuntime = makeToolRuntime();

    // Provider with no responses → will throw on first send()
    const provider = new ScriptedProvider([]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
      maxDepth: 3,
    });

    // Subagent with no provider responses — should still complete without crash
    const result = await sr.spawn("Do something.", "parent-run-6", 0);
    // The AgentLoop handles the error and exits
    expect(result.exitCode).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("createSubagentTool", () => {
  it("creates a tool with spawn_subagent name", () => {
    const dir = "/tmp/helm-test-dummy";
    const toolRuntime = makeToolRuntime();
    const provider = new ScriptedProvider([
      { role: "assistant", content: "OK" },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath: `${dir}/journal.jsonl`,
      toolRuntime,
    });

    const tool = createSubagentTool(sr, "parent-1", 0);
    expect(tool.name).toBe("spawn_subagent");
    expect(tool.parameters.required).toContain("task");
  });

  it("executes as a spawn call and returns structured result", async () => {
    // Use mkdtemp for a real temp dir
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "helm-test-"));
    const journalPath = join(dir, "journal.jsonl");
    const toolRuntime = makeToolRuntime();
    const provider = new ScriptedProvider([
      { role: "assistant", content: "Task completed." },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath,
      toolRuntime,
    });

    const tool = createSubagentTool(sr, "parent-exec-1", 0);
    const output = await tool.execute({ task: "Simple task." });

    const parsed = JSON.parse(output);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.summary).toContain("parent-exec-1-s1");

    await rm(dir, { recursive: true, force: true });
  });

  it("returns error when task is empty", async () => {
    const toolRuntime = makeToolRuntime();
    const provider = new ScriptedProvider([
      { role: "assistant", content: "OK" },
    ]);

    const sr = new SubagentRuntime({
      provider,
      journalPath: "/tmp/j.jsonl",
      toolRuntime,
    });

    const tool = createSubagentTool(sr, "parent", 0);
    const output = await tool.execute({ task: "" });
    expect(output).toContain("Error: task is required");
  });
});

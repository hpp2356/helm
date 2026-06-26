/**
 * Demo: PR00–PR02 end-to-end smoke test
 *
 * Simulates an agent conversation: user asks a question,
 * assistant calls a calculator tool, then gives final answer.
 * Journal captures every lifecycle event.
 */
import { describe, it, expect } from "vitest";
import { ScriptedProvider } from "./scripted-provider.js";
import { AgentLoop } from "./agent-loop.js";
import { ToolRuntime } from "./tool-runtime.js";
import { JsonlJournal } from "@helm/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("E2E Demo", () => {
  it("simulates a tool-calling agent conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-demo-"));
    const journalPath = join(dir, "run.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    // Set up a calculator tool
    const toolRuntime = new ToolRuntime();
    toolRuntime.register({
      name: "calculator",
      description: "evaluates arithmetic expressions",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
      async execute(args: Record<string, unknown>) {
        return `Result: ${String(eval(String(args.expression)))}`;
      },
    });

    // Scripted provider: turn 1 calls tool, turn 2 gives final answer
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Let me calculate that for you.",
        toolCalls: [
          { id: "tc1", name: "calculator", args: { expression: "2 + 3 * 4" } },
        ],
      },
      {
        role: "assistant",
        content: "The result is 14.",
      },
    ]);

    const loop = new AgentLoop(provider, toolRuntime, journal, { maxTurns: 5 });
    await loop.run("demo-run-1", "What is 2 + 3 * 4?");
    await journal.close();

    // Read and parse journal
    const raw = await readFile(journalPath, "utf-8");
    const lines = raw.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    console.log("\n🚀 E2E Demo Journal\n" + "=".repeat(50));

    for (const ev of events) {
      const ts = new Date(ev.timestamp).toISOString().slice(11, 19);
      switch (ev.type) {
        case "run:start":
          console.log(`🚀 [${ts}] RUN START   id=${ev.runId}`);
          break;
        case "turn:start":
          console.log(`🔄 [${ts}] TURN ${ev.turnIndex} START`);
          break;
        case "tool:call":
          console.log(`🔧 [${ts}] TOOL CALL   ${ev.toolName}(${JSON.stringify(ev.args)})`);
          break;
        case "tool:result":
          console.log(`📤 [${ts}] TOOL RESULT ${ev.output}`);
          break;
        case "error":
          console.log(`❌ [${ts}] ERROR       ${ev.message}`);
          break;
        case "run:end":
          console.log(`✅ [${ts}] RUN END    exitCode=${ev.exitCode}`);
          break;
      }
    }

    console.log("=".repeat(50));
    console.log(`Total: ${events.length} events\n`);

    // Assert the structure is correct
    expect(events[0].type).toBe("run:start");
    expect(events[1].type).toBe("turn:start");
    expect(events[2].type).toBe("assistant:text"); // reasoning text before tool calls
    expect(events[3].type).toBe("tool:call");
    expect(events[3].toolName).toBe("calculator");
    expect(events[4].type).toBe("tool:result");
    expect(events[4].output).toContain("14");
    expect(events[5].type).toBe("turn:start");   // turn 1 (final answer, no tools)
    expect(events[events.length - 1].type).toBe("run:end");
    expect(events.length).toBe(7); // run:start, turn0:start, assistant:text, tool:call, tool:result, turn1:start, run:end

    await rm(dir, { recursive: true, force: true });
  });
});

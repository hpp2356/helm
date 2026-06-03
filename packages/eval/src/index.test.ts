import { describe, it, expect } from "vitest";
import {
  EvalRunner,
  evaluateAssertion,
  type EvalCase,
  type EvalAssertion,
  type EvalSuiteResult,
} from "./index.js";
import type { RunEvent, Message } from "@helm/core";

// ── Test tools ────────────────────────────────────────────────────────────

const calcTool = {
  name: "calc",
  description: "Evaluate a math expression",
  parameters: { expr: "string" },
  execute: async (args: Record<string, unknown>) =>
    `result: ${String(args.expr)} = 42`,
};

const echoTool = {
  name: "echo",
  description: "Echo back the input",
  parameters: { text: "string" },
  execute: async (args: Record<string, unknown>) => String(args.text ?? ""),
};

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: "run:start",
    runId: "test-run",
    timestamp: 1,
    ...overrides,
  } as RunEvent;
}

// ── evaluateAssertion unit tests ──────────────────────────────────────────

describe("evaluateAssertion", () => {
  describe("event:exists", () => {
    it("passes when event type is found", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "tool:call", toolName: "calc", args: {}, turnIndex: 0 }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "event:exists", eventType: "tool:call" },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("fails when event type is not found", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "event:exists", eventType: "tool:call" },
        events,
        [],
      );
      expect(result.pass).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("event:order", () => {
    it("passes when expected types appear in order (subsequence)", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "turn:start", turnIndex: 0 }),
        makeEvent({ type: "tool:call", toolName: "calc", args: {}, turnIndex: 0 }),
        makeEvent({ type: "tool:result", toolName: "calc", output: "42", turnIndex: 0 }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "event:order", eventTypes: ["run:start", "tool:call", "run:end"] },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("fails when expected subsequence is out of order", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "tool:call", toolName: "calc", args: {}, turnIndex: 0 }),
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "event:order", eventTypes: ["run:start", "tool:call"] },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });

    it("fails when an expected type is missing entirely", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "event:order", eventTypes: ["run:start", "tool:call"] },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });
  });

  describe("tool:called", () => {
    it("passes when tool is called", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "tool:call", toolName: "calc", args: { expr: "1+1" }, turnIndex: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "tool:called", toolName: "calc" },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("passes when tool is called with matching args subset", () => {
      const events: RunEvent[] = [
        makeEvent({
          type: "tool:call",
          toolName: "calc",
          args: { expr: "1+1", extra: true },
          turnIndex: 0,
        }),
      ];
      const result = evaluateAssertion(
        { type: "tool:called", toolName: "calc", args: { expr: "1+1" } },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("fails when tool args do not match", () => {
      const events: RunEvent[] = [
        makeEvent({
          type: "tool:call",
          toolName: "calc",
          args: { expr: "2+2" },
          turnIndex: 0,
        }),
      ];
      const result = evaluateAssertion(
        { type: "tool:called", toolName: "calc", args: { expr: "1+1" } },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });

    it("fails when tool is not called at all", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "tool:call", toolName: "echo", args: {}, turnIndex: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "tool:called", toolName: "calc" },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });
  });

  describe("final:answer", () => {
    it("passes when last assistant message contains expected text", () => {
      const messages: Message[] = [
        { role: "assistant", content: "The answer is 42" },
      ];
      const result = evaluateAssertion(
        { type: "final:answer", contains: "42" },
        [],
        messages,
      );
      expect(result.pass).toBe(true);
    });

    it("passes when last assistant message matches exactly", () => {
      const messages: Message[] = [
        { role: "assistant", content: "The answer is 42" },
      ];
      const result = evaluateAssertion(
        { type: "final:answer", matches: "The answer is 42" },
        [],
        messages,
      );
      expect(result.pass).toBe(true);
    });

    it("fails when content does not contain expected text", () => {
      const messages: Message[] = [
        { role: "assistant", content: "Hello world" },
      ];
      const result = evaluateAssertion(
        { type: "final:answer", contains: "42" },
        [],
        messages,
      );
      expect(result.pass).toBe(false);
    });

    it("fails when there is no assistant message", () => {
      const result = evaluateAssertion(
        { type: "final:answer", contains: "42" },
        [],
        [],
      );
      expect(result.pass).toBe(false);
      expect(result.message).toContain("no assistant message captured");
    });
  });

  describe("error:category", () => {
    it("passes when matching error category is found", () => {
      const events: RunEvent[] = [
        makeEvent({
          type: "error",
          message: "rate limit exceeded",
          errorType: "provider",
          errorCategory: "rate_limit",
        }),
      ];
      const result = evaluateAssertion(
        { type: "error:category", errorCategory: "rate_limit" },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("passes when matching errorType as fallback", () => {
      const events: RunEvent[] = [
        makeEvent({
          type: "error",
          message: "something broke",
          errorType: "provider",
          errorCategory: "server_error",
        }),
      ];
      const result = evaluateAssertion(
        { type: "error:category", errorCategory: "provider" },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("fails when no error matches the category", () => {
      const events: RunEvent[] = [
        makeEvent({
          type: "error",
          message: "something broke",
          errorType: "provider",
          errorCategory: "server_error",
        }),
      ];
      const result = evaluateAssertion(
        { type: "error:category", errorCategory: "rate_limit" },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });
  });

  describe("no:error", () => {
    it("passes when there are no error events", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "no:error" },
        events,
        [],
      );
      expect(result.pass).toBe(true);
    });

    it("fails when there are error events", () => {
      const events: RunEvent[] = [
        makeEvent({ type: "run:start" }),
        makeEvent({
          type: "error",
          message: "fail",
          errorType: "provider",
          errorCategory: "unknown",
        }),
        makeEvent({ type: "run:end", exitCode: 0 }),
      ];
      const result = evaluateAssertion(
        { type: "no:error" },
        events,
        [],
      );
      expect(result.pass).toBe(false);
    });
  });
});

// ── EvalRunner integration tests ──────────────────────────────────────────

describe("EvalRunner", () => {
  const runner = new EvalRunner();

  describe("runCase", () => {
    it("passes all assertions for a valid case with tool calls and final answer", async () => {
      const evalCase: EvalCase = {
        name: "simple calc",
        description: "Agent uses calc tool then gives final answer",
        script: [
          {
            role: "assistant",
            content: "Let me calculate",
            toolCalls: [
              { id: "1", name: "calc", args: { expr: "6*7" } },
            ],
          },
          { role: "assistant", content: "The answer is 42" },
        ],
        tools: [calcTool],
        assertions: [
          { type: "event:exists", eventType: "tool:call" },
          { type: "tool:called", toolName: "calc" },
          { type: "final:answer", contains: "42" },
          { type: "no:error" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(true);
      expect(result.results).toHaveLength(4);
      for (const r of result.results) {
        expect(r.pass).toBe(true);
      }
    });

    it("fails on event:exists when expected event type is absent", async () => {
      const evalCase: EvalCase = {
        name: "no tool calls",
        script: [{ role: "assistant", content: "Done" }],
        assertions: [
          { type: "event:exists", eventType: "tool:call" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(false);
      expect(result.results[0].pass).toBe(false);
      expect(result.results[0].message).toContain("not found");
    });

    it("fails on tool:called when wrong tool name asserted", async () => {
      const evalCase: EvalCase = {
        name: "wrong tool assertion",
        script: [
          {
            role: "assistant",
            content: "echo this",
            toolCalls: [
              { id: "1", name: "echo", args: { text: "hello" } },
            ],
          },
          { role: "assistant", content: "Done" },
        ],
        tools: [echoTool],
        assertions: [
          { type: "tool:called", toolName: "calc" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(false);
      expect(result.results[0].pass).toBe(false);
    });

    it("fails on final:answer when content does not match", async () => {
      const evalCase: EvalCase = {
        name: "wrong answer assertion",
        script: [{ role: "assistant", content: "Hello world" }],
        assertions: [
          { type: "final:answer", contains: "Goodbye" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(false);
      expect(result.results[0].pass).toBe(false);
    });

    it("passes error:category when ScriptedProvider injects an error", async () => {
      const evalCase: EvalCase = {
        name: "error injection",
        script: [
          { _error: true, message: "rate limit hit", category: "rate_limit" },
        ],
        assertions: [
          { type: "error:category", errorCategory: "rate_limit" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(true);
      expect(result.results[0].pass).toBe(true);
    });

    it("supports event:order assertion", async () => {
      const evalCase: EvalCase = {
        name: "event order check",
        script: [
          {
            role: "assistant",
            content: "calc this",
            toolCalls: [
              { id: "1", name: "calc", args: { expr: "1+1" } },
            ],
          },
          { role: "assistant", content: "Done" },
        ],
        tools: [calcTool],
        assertions: [
          {
            type: "event:order",
            eventTypes: ["run:start", "turn:start", "tool:call", "tool:result", "run:end"],
          },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(true);
      expect(result.results[0].pass).toBe(true);
    });

    it("handles edge case: minimal script with no tool calls", async () => {
      const evalCase: EvalCase = {
        name: "minimal no-tool case",
        script: [{ role: "assistant", content: "Just an answer" }],
        assertions: [
          { type: "event:exists", eventType: "run:start" },
          { type: "event:exists", eventType: "turn:start" },
          { type: "event:exists", eventType: "run:end" },
          { type: "no:error" },
        ],
      };

      const result = await runner.runCase(evalCase);
      expect(result.pass).toBe(true);
    });
  });

  describe("runSuite", () => {
    it("aggregates multiple cases with mixed pass/fail", async () => {
      const passingCase: EvalCase = {
        name: "passing",
        script: [{ role: "assistant", content: "OK" }],
        assertions: [
          { type: "event:exists", eventType: "run:start" },
          { type: "no:error" },
        ],
      };

      const failingCase: EvalCase = {
        name: "failing",
        script: [{ role: "assistant", content: "OK" }],
        assertions: [
          { type: "event:exists", eventType: "tool:call" },
        ],
      };

      const suiteResult = await runner.runSuite([passingCase, failingCase]);

      expect(suiteResult.totalCases).toBe(2);
      expect(suiteResult.passedCases).toBe(1);
      expect(suiteResult.failedCases).toBe(1);
      expect(suiteResult.totalAssertions).toBe(3);
      expect(suiteResult.passedAssertions).toBe(2);
      expect(suiteResult.failedAssertions).toBe(1);

      expect(suiteResult.cases[0].pass).toBe(true);
      expect(suiteResult.cases[1].pass).toBe(false);

      expect(suiteResult.summary).toContain("Cases: 1/2 passed");
      expect(suiteResult.summary).toContain("PASS  passing");
      expect(suiteResult.summary).toContain("FAIL  failing");
      expect(suiteResult.summary).toContain("Assertions: 2/3 passed");
    });

    it("returns all-passing suite for all-passing cases", async () => {
      const cases: EvalCase[] = [
        {
          name: "case 1",
          script: [{ role: "assistant", content: "A" }],
          assertions: [{ type: "no:error" }],
        },
        {
          name: "case 2",
          script: [{ role: "assistant", content: "B" }],
          assertions: [{ type: "event:exists", eventType: "run:start" }],
        },
      ];

      const suiteResult = await runner.runSuite(cases);

      expect(suiteResult.passedCases).toBe(2);
      expect(suiteResult.failedCases).toBe(0);
      expect(suiteResult.summary).toContain("Cases: 2/2 passed");
    });
  });
});

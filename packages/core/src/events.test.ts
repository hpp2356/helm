import { describe, it, expect } from "vitest";
import { eventToString, type RunEvent } from "./events.js";

describe("eventToString", () => {
  it("should serialize run:start event", () => {
    const event: RunEvent = {
      type: "run:start",
      runId: "run-1",
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("run:start");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.timestamp).toBe(1717200000000);
  });

  it("should serialize run:end event", () => {
    const event: RunEvent = {
      type: "run:end",
      runId: "run-1",
      timestamp: 1717200001000,
      exitCode: 0,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("run:end");
    expect(parsed.exitCode).toBe(0);
  });

  it("should serialize turn:start event", () => {
    const event: RunEvent = {
      type: "turn:start",
      runId: "run-1",
      turnIndex: 0,
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("turn:start");
    expect(parsed.turnIndex).toBe(0);
  });

  it("should serialize turn:end event", () => {
    const event: RunEvent = {
      type: "turn:end",
      runId: "run-1",
      turnIndex: 0,
      timestamp: 1717200001000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("turn:end");
    expect(parsed.turnIndex).toBe(0);
  });

  it("should serialize tool:call event", () => {
    const event: RunEvent = {
      type: "tool:call",
      runId: "run-1",
      turnIndex: 0,
      toolName: "read",
      args: { file_path: "/tmp/test.txt" },
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("tool:call");
    expect(parsed.toolName).toBe("read");
    expect(parsed.args).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("should serialize tool:result event", () => {
    const event: RunEvent = {
      type: "tool:result",
      runId: "run-1",
      turnIndex: 0,
      toolName: "read",
      output: "file contents here",
      timestamp: 1717200001000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("tool:result");
    expect(parsed.output).toBe("file contents here");
  });

  it("should serialize error event with stack", () => {
    const event: RunEvent = {
      type: "error",
      runId: "run-1",
      message: "something went wrong",
      stack: "Error: something went wrong\n    at foo (bar.ts:1:2)",
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("error");
    expect(parsed.message).toBe("something went wrong");
    expect(parsed.stack).toBe(
      "Error: something went wrong\n    at foo (bar.ts:1:2)"
    );
  });

  it("should serialize error event without stack", () => {
    const event: RunEvent = {
      type: "error",
      runId: "run-1",
      message: "something went wrong",
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("error");
    expect(parsed.message).toBe("something went wrong");
    expect(parsed.stack).toBeUndefined();
  });

  it("should produce valid JSON with no line breaks in the output", () => {
    const event: RunEvent = {
      type: "run:start",
      runId: "run-1",
      timestamp: 1717200000000,
    };
    const result = eventToString(event);
    // JSONL requires no embedded newlines
    expect(result).not.toContain("\n");
  });
});

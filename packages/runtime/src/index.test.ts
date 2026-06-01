import { describe, it, expect } from "vitest";
import { ScriptedProvider, AgentLoop, ToolRuntime, type AgentLoopOptions } from "./index.js";

describe("@helm/runtime", () => {
  it("should export ScriptedProvider", () => {
    expect(typeof ScriptedProvider).toBe("function");
  });

  it("should export AgentLoop", () => {
    expect(typeof AgentLoop).toBe("function");
  });

  it("should export ToolRuntime", () => {
    expect(typeof ToolRuntime).toBe("function");
  });

  it("should re-export AgentLoopOptions as a type (compile-time check)", () => {
    const opts: AgentLoopOptions = { maxTurns: 5 };
    expect(opts.maxTurns).toBe(5);
  });
});

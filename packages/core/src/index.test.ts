import { describe, it, expect } from "vitest";
import {
  eventToString,
  JsonlJournal,
  type RunEvent,
  type Message,
  type ToolCall,
  type Provider,
  type Tool,
} from "./index.js";

describe("@helm/core", () => {
  it("should export eventToString", () => {
    expect(typeof eventToString).toBe("function");
  });

  it("should export JsonlJournal", () => {
    expect(typeof JsonlJournal).toBe("function");
  });

  it("should re-export RunEvent as a type (compile-time check)", () => {
    const event: RunEvent = {
      type: "run:start",
      runId: "test",
      timestamp: 1,
    };
    expect(event.type).toBe("run:start");
  });

  it("should export Message as a type (compile-time check)", () => {
    const msg: Message = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
  });

  it("should export ToolCall as a type (compile-time check)", () => {
    const tc: ToolCall = { id: "1", name: "test", args: {} };
    expect(tc.name).toBe("test");
  });

  it("should export Provider as a type (compile-time check)", () => {
    const p: Provider = { send: async () => ({ role: "assistant", content: "" }) };
    expect(typeof p.send).toBe("function");
  });

  it("should export Tool as a type (compile-time check)", () => {
    const t: Tool = {
      name: "test",
      description: "a test tool",
      parameters: {},
      execute: async () => "ok",
    };
    expect(t.name).toBe("test");
  });
});

import { describe, it, expect } from "vitest";
import { ToolRuntime } from "./tool-runtime.js";
import type { Tool } from "@helm/core";

function makeEchoTool(): Tool {
  return {
    name: "echo",
    description: "echos input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    async execute(args: Record<string, unknown>) {
      return `echo: ${args.text}`;
    },
  };
}

describe("ToolRuntime", () => {
  it("registers a tool", () => {
    const rt = new ToolRuntime();
    rt.register(makeEchoTool());
    expect(rt.has("echo")).toBe(true);
  });

  it("throws on duplicate registration", () => {
    const rt = new ToolRuntime();
    rt.register(makeEchoTool());
    expect(() => rt.register(makeEchoTool())).toThrow("already registered");
  });

  it("lists registered tools", () => {
    const rt = new ToolRuntime();
    rt.register(makeEchoTool());
    rt.register({
      name: "add",
      description: "adds two numbers",
      parameters: {},
      async execute(args: Record<string, unknown>) {
        return String(Number(args.a) + Number(args.b));
      },
    });
    expect(rt.list()).toHaveLength(2);
    expect(rt.getToolNames()).toEqual(["echo", "add"]);
  });

  it("executes a tool by name", async () => {
    const rt = new ToolRuntime();
    rt.register(makeEchoTool());
    const result = await rt.execute("echo", { text: "hello" });
    expect(result).toBe("echo: hello");
  });

  it("returns error for unknown tool", async () => {
    const rt = new ToolRuntime();
    const result = await rt.execute("nonexistent", {});
    expect(result).toContain('unknown tool "nonexistent"');
  });

  it("returns error when tool throws", async () => {
    const rt = new ToolRuntime();
    rt.register({
      name: "explode",
      description: "always throws",
      parameters: {},
      async execute(_args: Record<string, unknown>) {
        throw new Error("boom");
      },
    });
    const result = await rt.execute("explode", {});
    expect(result).toBe("Error: boom");
  });
});

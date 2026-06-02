import { describe, it, expect } from "vitest";
import { ToolRuntime } from "./tool-runtime.js";
import { PermissionRuntime } from "./permission-runtime.js";
import type { Tool } from "@helm/core";
import { RiskLevel } from "@helm/core";

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

describe("ToolRuntime with PermissionRuntime", () => {
  it("executes when permission allows", async () => {
    const perm = new PermissionRuntime();
    perm.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
    const rt = new ToolRuntime(perm);
    rt.register(makeEchoTool());
    const result = await rt.execute("echo", { text: "hi" });
    expect(result).toBe("echo: hi");
  });

  it("denies when permission disallows", async () => {
    const perm = new PermissionRuntime();
    // No allow rule → default deny
    const rt = new ToolRuntime(perm);
    rt.register(makeEchoTool());
    const result = await rt.execute("echo", { text: "hi" });
    expect(result).toContain("permission denied");
  });

  it("denies when tool is on denylist", async () => {
    const perm = new PermissionRuntime();
    perm.allow({ pattern: "echo", riskLevel: RiskLevel.LOW, description: "echo" });
    perm.deny({ pattern: "echo", riskLevel: RiskLevel.CRITICAL, description: "blocked" });
    const rt = new ToolRuntime(perm);
    rt.register(makeEchoTool());
    const result = await rt.execute("echo", { text: "hi" });
    expect(result).toContain("permission denied");
  });

  it("allows all tools when no PermissionRuntime (backward compat)", async () => {
    const rt = new ToolRuntime(); // no PermissionRuntime
    rt.register(makeEchoTool());
    const result = await rt.execute("echo", { text: "hi" });
    expect(result).toBe("echo: hi");
  });
});

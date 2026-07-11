import { describe, it, expect } from "vitest";
import { SkillRegistry } from "./registry.js";
import type { Skill, SkillContext } from "./types.js";

function makeTestSkill(name: string, desc = "test"): Skill {
  return {
    name,
    description: desc,
    handler: async (input) => `result:${name}:${input}`,
  };
}

function makeCtx(): SkillContext {
  return {
    tools: new Map(),
    messages: [],
    addMessage: () => {},
    runId: "test",
  };
}

describe("SkillRegistry", () => {
  it("registers and retrieves a skill", () => {
    const reg = new SkillRegistry();
    reg.register(makeTestSkill("hello"));
    expect(reg.has("hello")).toBe(true);
    expect(reg.get("hello")!.name).toBe("hello");
  });

  it("lists all registered skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeTestSkill("a"));
    reg.register(makeTestSkill("b"));
    reg.register(makeTestSkill("c"));
    expect(reg.list()).toHaveLength(3);
    expect(reg.count).toBe(3);
  });

  it("first registration wins on name conflict", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "x", description: "first", handler: async () => "first" });
    reg.register({ name: "x", description: "second", handler: async () => "second" });
    expect(reg.get("x")!.description).toBe("first");
    expect(reg.count).toBe(1);
  });

  it("case-insensitive lookup", () => {
    const reg = new SkillRegistry();
    reg.register(makeTestSkill("help"));
    expect(reg.has("Help")).toBe(true);
    expect(reg.has("HELP")).toBe(true);
  });

  it("returns undefined for unknown skill", () => {
    const reg = new SkillRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
    expect(reg.has("nonexistent")).toBe(false);
  });

  it("execute returns handler output", async () => {
    const reg = new SkillRegistry();
    reg.register(makeTestSkill("echo"));
    const result = await reg.execute("echo", "hello world", makeCtx());
    expect(result).toBe("result:echo:hello world");
  });

  it("execute returns error message for unknown skill", async () => {
    const reg = new SkillRegistry();
    const result = await reg.execute("nope", "", makeCtx());
    expect(result).toContain("Unknown skill");
    expect(result).toContain("/nope");
  });

  it("execute catches handler errors gracefully", async () => {
    const reg = new SkillRegistry();
    reg.register({
      name: "boom",
      description: "throws",
      handler: async () => { throw new Error("kaboom"); },
    });
    const result = await reg.execute("boom", "", makeCtx());
    expect(result).toContain("Error in /boom");
    expect(result).toContain("kaboom");
  });

  it("emits journal events on skill call", async () => {
    const events: Record<string, unknown>[] = [];
    const journal = {
      async append(event: Record<string, unknown>) { events.push(event); },
      open: async () => {},
      close: async () => {},
    };
    const reg = new SkillRegistry({ journal: journal as any, runId: "test" });
    reg.register(makeTestSkill("my-skill"));
    await reg.execute("my-skill", "some input", makeCtx());

    const callEvent = events.find((e) => e.type === "skill:call");
    expect(callEvent).toBeDefined();
    expect(callEvent!.skillName).toBe("my-skill");
    expect(callEvent!.input).toBe("some input");
  });

  it("emits journal events on skill error", async () => {
    const events: Record<string, unknown>[] = [];
    const journal = {
      async append(event: Record<string, unknown>) { events.push(event); },
      open: async () => {},
      close: async () => {},
    };
    const reg = new SkillRegistry({ journal: journal as any, runId: "test" });
    reg.register({
      name: "fail",
      description: "fails",
      handler: async () => { throw new Error("oops"); },
    });
    await reg.execute("fail", "", makeCtx());

    const errorEvent = events.find((e) => e.type === "skill:error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.skillName).toBe("fail");
    expect(errorEvent!.message).toContain("oops");
  });
});

import { describe, it, expect } from "vitest";
import { SkillRegistry } from "./registry.js";
import { createBuiltinSkills } from "./builtins.js";
import type { BuiltinDeps } from "./builtins.js";
import type { SkillContext } from "./types.js";

function makeDeps(overrides: Partial<BuiltinDeps> = {}): BuiltinDeps {
  const registry = new SkillRegistry();
  return {
    getToolNames: () => ["read", "write", "bash"],
    getMessageCount: () => 5,
    getTurnCount: () => 3,
    providerName: "test-provider",
    journalPath: "/tmp/test.jsonl",
    getPlugins: () => [{ name: "my-plugin", version: "1.0.0", toolCount: 2 }],
    clearMessages: () => 4,
    close: () => {},
    registry,
    ...overrides,
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

describe("builtin skills", () => {
  it("/help lists all registered skills", async () => {
    const deps = makeDeps();
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("help", "", makeCtx());
    expect(result).toContain("/help");
    expect(result).toContain("/tools");
    expect(result).toContain("/clear");
    expect(result).toContain("/exit");
    expect(result).toContain("/stats");
    expect(result).toContain("/plugins");
  });

  it("/tools lists all tool names", async () => {
    const deps = makeDeps();
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("tools", "", makeCtx());
    expect(result).toContain("read");
    expect(result).toContain("write");
    expect(result).toContain("bash");
    expect(result).toContain("Tools (3)");
  });

  it("/clear clears messages", async () => {
    const deps = makeDeps();
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("clear", "", makeCtx());
    expect(result).toContain("cleared");
    expect(result).toContain("4 messages removed");
  });

  it("/exit calls close", async () => {
    let closed = false;
    const deps = makeDeps({ close: () => { closed = true; } });
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("exit", "", makeCtx());
    expect(result).toBe("Goodbye.");
    expect(closed).toBe(true);
  });

  it("/stats shows session info", async () => {
    const deps = makeDeps();
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("stats", "", makeCtx());
    expect(result).toContain("Messages: 5");
    expect(result).toContain("Turns:    3");
    expect(result).toContain("Provider: test-provider");
  });

  it("/plugins lists loaded plugins", async () => {
    const deps = makeDeps();
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("plugins", "", makeCtx());
    expect(result).toContain("my-plugin");
    expect(result).toContain("v1.0.0");
    expect(result).toContain("2 tools");
  });

  it("/plugins shows none when empty", async () => {
    const deps = makeDeps({ getPlugins: () => [] });
    const skills = createBuiltinSkills(deps);
    for (const s of skills) deps.registry.register(s);

    const result = await deps.registry.execute("plugins", "", makeCtx());
    expect(result).toContain("No plugins");
  });
});

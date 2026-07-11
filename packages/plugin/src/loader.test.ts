import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader, StaticConfigSource } from "./loader.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

/** Create a unique temp directory for a single test. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "helm-plugin-test-"));
}

/** Recursively remove a directory (best-effort). */
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("PluginLoader", () => {
  it("loads a valid plugin from directory", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    const results = await loader.loadAll();
    const testResult = results.find((r) => r.pluginName === "test-plugin");
    expect(testResult).toBeDefined();
    expect(testResult!.status).toBe("loaded");
    expect(loader.getLoadedPlugins().some((p) => p.name === "test-plugin")).toBe(true);
  });

  it("registers tools from loaded plugin", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    await loader.loadAll();
    const tools = loader.getTools();
    const echoTool = tools.find((t) => t.name === "test-plugin__echo");
    expect(echoTool).toBeDefined();
    expect(echoTool!.description).toBe("Echoes input back");
  });

  it("executes plugin tool", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    await loader.loadAll();
    const tools = loader.getTools();
    const echoTool = tools.find((t) => t.name === "test-plugin__echo")!;
    const result = await echoTool.execute({ text: "hello" });
    expect(result).toBe("echo: hello");
  });

  it("registers skills from loaded plugin", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    await loader.loadAll();
    const skills = loader.getSkills();
    const greetSkill = skills.find((s) => s.name === "greet");
    expect(greetSkill).toBeDefined();
    expect(greetSkill!.pluginName).toBe("test-plugin");
  });

  it("registers prompts from loaded plugin", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    await loader.loadAll();
    const prompts = loader.getPrompts();
    const helloPrompt = prompts.find((p) => p.name === "hello");
    expect(helloPrompt).toBeDefined();
    expect(helloPrompt!.template).toBe("Hello, {{name}}!");
  });

  it("skips plugin with invalid manifest (graceful skip)", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    const results = await loader.loadAll();
    const invalidResult = results.find((r) => r.pluginName === "invalid-manifest-plugin");
    expect(invalidResult).toBeDefined();
    expect(invalidResult!.status).toBe("failed");
    expect(invalidResult!.error).toContain("invalid plugin name");
    expect(loader.count).toBeGreaterThan(0);
  });

  it("skips plugin with missing entry file but still loads manifest tools", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    const results = await loader.loadAll();
    const brokenResult = results.find((r) => r.pluginName === "broken-plugin");
    expect(brokenResult).toBeDefined();
    expect(brokenResult!.status).toBe("loaded");
    const brokenTools = loader.getTools().filter((t) => t.name.startsWith("broken-plugin__"));
    expect(brokenTools).toHaveLength(0);
  });

  it("loads manifest-only plugin with stub tool", async () => {
    const loader = new PluginLoader({ pluginDirs: [FIXTURES] });
    await loader.loadAll();
    const tools = loader.getTools();
    const stubTool = tools.find((t) => t.name === "manifest-only__stub-tool");
    expect(stubTool).toBeDefined();
    const result = await stubTool!.execute({});
    expect(result).toContain("no implementation");
  });

  it("skips non-existent plugin directories", async () => {
    const loader = new PluginLoader({ pluginDirs: ["/nonexistent/path"] });
    const results = await loader.loadAll();
    expect(results).toHaveLength(0);
    expect(loader.count).toBe(0);
  });

  it("loads plugin with entry file from temp directory", async () => {
    const tmpDir = makeTmpDir();
    try {
      const pluginDir = resolve(tmpDir, "my-plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(resolve(pluginDir, "plugin.json"), JSON.stringify({
        name: "my-plugin",
        version: "0.1.0",
        tools: [{ name: "test-tool" }],
      }));
      writeFileSync(resolve(pluginDir, "index.js"), `
        export default {
          tools: [{
            name: "test-tool",
            async execute() { return "works"; },
          }],
        };
      `);

      const loader = new PluginLoader({ pluginDirs: [tmpDir] });
      const results = await loader.loadAll();
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe("loaded");
      expect(loader.getTools()).toHaveLength(1);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("resolves config from StaticConfigSource", async () => {
    const configSource = new StaticConfigSource({ apiKey: "secret-123" });
    const loader = new PluginLoader({
      pluginDirs: [FIXTURES],
      configSource,
    });
    await loader.loadAll();
    const plugin = loader.getLoadedPlugins().find((p) => p.name === "test-plugin");
    expect(plugin).toBeDefined();
  });

  it("first plugin wins when duplicates exist", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dir1 = resolve(tmpDir, "dir1");
      const dir2 = resolve(tmpDir, "dir2");
      mkdirSync(resolve(dir1, "dup-plugin"), { recursive: true });
      mkdirSync(resolve(dir2, "dup-plugin"), { recursive: true });

      const manifest = JSON.stringify({ name: "dup-plugin", version: "1.0.0" });
      writeFileSync(resolve(dir1, "dup-plugin", "plugin.json"), manifest);
      writeFileSync(resolve(dir2, "dup-plugin", "plugin.json"), manifest);

      const loader = new PluginLoader({ pluginDirs: [dir1, dir2] });
      await loader.loadAll();
      expect(loader.count).toBe(1);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("calls destroy on all plugins", async () => {
    const tmpDir = makeTmpDir();
    try {
      const pluginDir = resolve(tmpDir, "destroy-test");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(resolve(pluginDir, "plugin.json"), JSON.stringify({
        name: "destroy-test",
        version: "1.0.0",
      }));
      writeFileSync(resolve(pluginDir, "index.js"), `
        export default {
          async destroy() {},
        };
      `);

      const loader = new PluginLoader({ pluginDirs: [tmpDir] });
      await loader.loadAll();
      await loader.destroyAll();
    } finally {
      cleanup(tmpDir);
    }
  });

  it("handles multiple plugin directories", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dir1 = resolve(tmpDir, "dir1");
      const dir2 = resolve(tmpDir, "dir2");
      mkdirSync(resolve(dir1, "plugin-a"), { recursive: true });
      mkdirSync(resolve(dir2, "plugin-b"), { recursive: true });

      writeFileSync(resolve(dir1, "plugin-a", "plugin.json"), JSON.stringify({ name: "plugin-a", version: "1.0.0" }));
      writeFileSync(resolve(dir2, "plugin-b", "plugin.json"), JSON.stringify({ name: "plugin-b", version: "2.0.0" }));

      const loader = new PluginLoader({ pluginDirs: [dir1, dir2] });
      await loader.loadAll();
      expect(loader.count).toBe(2);
      const names = loader.getLoadedPlugins().map((p) => p.name).sort();
      expect(names).toEqual(["plugin-a", "plugin-b"]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("emits journal events on load", async () => {
    const tmpDir = makeTmpDir();
    try {
      const events: Record<string, unknown>[] = [];
      const journal = {
        async append(event: Record<string, unknown>) { events.push(event); },
        open: async () => {},
        close: async () => {},
      };
      const loader = new PluginLoader({
        pluginDirs: [tmpDir],
        journal: journal as any,
        runId: "test-run",
      });

      const pluginDir = resolve(tmpDir, "journal-test");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(resolve(pluginDir, "plugin.json"), JSON.stringify({ name: "journal-test", version: "1.0.0" }));

      await loader.loadAll();
      const loadEvent = events.find((e) => e.type === "plugin:load");
      expect(loadEvent).toBeDefined();
      expect(loadEvent!.pluginName).toBe("journal-test");
      expect(loadEvent!.pluginVersion).toBe("1.0.0");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("emits journal events on error", async () => {
    const events: Record<string, unknown>[] = [];
    const journal = {
      async append(event: Record<string, unknown>) { events.push(event); },
      open: async () => {},
      close: async () => {},
    };
    const loader = new PluginLoader({
      pluginDirs: [FIXTURES],
      journal: journal as any,
      runId: "test-run",
    });

    await loader.loadAll();
    const errorEvent = events.find((e) => e.type === "plugin:error" && e.pluginName === "invalid-manifest-plugin");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain("invalid plugin name");
  });
});

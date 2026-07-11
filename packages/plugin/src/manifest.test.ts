import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readManifest, validateManifest } from "./manifest.js";
import { PluginError } from "./types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

describe("readManifest", () => {
  it("reads a valid plugin manifest", () => {
    const manifest = readManifest(resolve(FIXTURES, "test-plugin"));
    expect(manifest.name).toBe("test-plugin");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.description).toBe("A test plugin for unit tests");
    expect(manifest.main).toBe("index.js");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools![0]!.name).toBe("echo");
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills![0]!.name).toBe("greet");
    expect(manifest.prompts).toHaveLength(1);
    expect(manifest.prompts![0]!.name).toBe("hello");
    expect(manifest.config).toHaveLength(1);
    expect(manifest.config![0]!.key).toBe("apiKey");
  });

  it("throws PluginError when manifest not found", () => {
    expect(() => readManifest("/nonexistent/path")).toThrow(PluginError);
    expect(() => readManifest("/nonexistent/path")).toThrow("manifest not found");
  });

  it("throws PluginError for invalid JSON", () => {
    // Create a temp dir with invalid JSON
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const tmpDir = resolve(FIXTURES, ".tmp-invalid-json");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(resolve(tmpDir, "plugin.json"), "not json {{{");
    try {
      expect(() => readManifest(tmpDir)).toThrow(PluginError);
      expect(() => readManifest(tmpDir)).toThrow("invalid JSON");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("validateManifest", () => {
  it("validates a minimal manifest", () => {
    const result = validateManifest({ name: "my-plugin", version: "1.0.0" }, "/tmp");
    expect(result.name).toBe("my-plugin");
    expect(result.version).toBe("1.0.0");
  });

  it("rejects missing name", () => {
    expect(() => validateManifest({ version: "1.0.0" }, "/tmp")).toThrow('missing required field "name"');
  });

  it("rejects empty name", () => {
    expect(() => validateManifest({ name: "", version: "1.0.0" }, "/tmp")).toThrow('missing required field "name"');
  });

  it("rejects missing version", () => {
    expect(() => validateManifest({ name: "test" }, "/tmp")).toThrow('missing required field "version"');
  });

  it("rejects invalid plugin name format", () => {
    expect(() => validateManifest({ name: "INVALID NAME!", version: "1.0.0" }, "/tmp")).toThrow("invalid plugin name");
  });

  it("accepts valid plugin name with hyphens", () => {
    const result = validateManifest({ name: "my-cool-plugin", version: "1.0.0" }, "/tmp");
    expect(result.name).toBe("my-cool-plugin");
  });

  it("rejects non-object manifest", () => {
    expect(() => validateManifest("string", "/tmp")).toThrow("must be a JSON object");
    expect(() => validateManifest(null, "/tmp")).toThrow("must be a JSON object");
  });

  it("validates tools array", () => {
    const result = validateManifest({
      name: "test",
      version: "1.0.0",
      tools: [{ name: "tool1" }],
    }, "/tmp");
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]!.name).toBe("tool1");
  });

  it("rejects invalid tools array", () => {
    expect(() => validateManifest({
      name: "test",
      version: "1.0.0",
      tools: "not-array",
    }, "/tmp")).toThrow('"tools" must be an array');
  });

  it("rejects tool without name", () => {
    expect(() => validateManifest({
      name: "test",
      version: "1.0.0",
      tools: [{}],
    }, "/tmp")).toThrow('tools[0] missing required field "name"');
  });

  it("validates skills array", () => {
    const result = validateManifest({
      name: "test",
      version: "1.0.0",
      skills: [{ name: "my-skill", description: "does things" }],
    }, "/tmp");
    expect(result.skills).toHaveLength(1);
    expect(result.skills![0]!.name).toBe("my-skill");
  });

  it("validates prompts array", () => {
    const result = validateManifest({
      name: "test",
      version: "1.0.0",
      prompts: [{ name: "my-prompt", template: "Hello {{name}}" }],
    }, "/tmp");
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts![0]!.template).toBe("Hello {{name}}");
  });

  it("validates config array", () => {
    const result = validateManifest({
      name: "test",
      version: "1.0.0",
      config: [{ key: "apiKey", required: true }],
    }, "/tmp");
    expect(result.config).toHaveLength(1);
    expect(result.config![0]!.key).toBe("apiKey");
    expect(result.config![0]!.required).toBe(true);
  });
});

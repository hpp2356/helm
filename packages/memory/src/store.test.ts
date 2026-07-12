import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `helm-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MemoryStore", () => {
  let tmpDir: string;
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = join(tmpDir, "user");
    projectDir = join(tmpDir, "project");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads empty when no files exist", () => {
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    expect(result.instructions).toHaveLength(0);
    expect(result.auto).toHaveLength(0);
    expect(result.rules).toHaveLength(0);
    expect(result.totalLines).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("loads user.md as instruction memory", () => {
    writeFileSync(join(userDir, "user.md"), `---\ntype: instruction\n---\n\n## Preferences\n\nAlways respond in Chinese.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    expect(result.instructions.length).toBeGreaterThanOrEqual(1);
    const pref = result.instructions.find((e) => e.heading === "Preferences");
    expect(pref).toBeDefined();
    expect(pref!.content).toContain("Always respond in Chinese");
    expect(pref!.scope).toBe("user");
  });

  it("loads project.md as instruction memory", () => {
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\n- pnpm test\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    expect(result.instructions.length).toBeGreaterThanOrEqual(1);
    const build = result.instructions.find((e) => e.heading === "Build");
    expect(build).toBeDefined();
    expect(build!.content).toContain("pnpm test");
    expect(build!.scope).toBe("project");
  });

  it("loads auto.md as auto memory", () => {
    writeFileSync(join(projectDir, "auto.md"), `---\ntype: auto\n---\n\n### discovery: 2026-07-12\n\nvitest fails without typecheck first.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    expect(result.auto.length).toBeGreaterThanOrEqual(1);
    expect(result.auto[0]!.content).toContain("vitest fails");
  });

  it("loads rules from rules/*.md", () => {
    mkdirSync(join(projectDir, "rules"), { recursive: true });
    writeFileSync(join(projectDir, "rules", "typescript.md"), `---\ndescription: TypeScript rules\nglobs: **/*.ts\n---\n\n- Use strict mode\n- Prefer interface over type\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.description).toBe("TypeScript rules");
    expect(result.rules[0]!.globs).toEqual(["**/*.ts"]);
    expect(result.rules[0]!.content).toContain("strict mode");
  });

  it("getInstructionText returns combined instructions", () => {
    writeFileSync(join(userDir, "user.md"), `---\ntype: instruction\n---\n\n## Pref\n\nChinese.\n`);
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\npnpm test.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const text = store.getInstructionText();
    expect(text).toContain("Chinese");
    expect(text).toContain("pnpm test");
  });

  it("getAutoText returns auto memory", () => {
    writeFileSync(join(projectDir, "auto.md"), `---\ntype: auto\n---\n\n### discovery\n\nFound something.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const text = store.getAutoText();
    expect(text).toContain("Found something");
  });

  it("getRulesForFile filters by glob", () => {
    mkdirSync(join(projectDir, "rules"), { recursive: true });
    writeFileSync(join(projectDir, "rules", "ts.md"), `---\ndescription: TS\nglobs: **/*.ts\n---\n\n- strict\n`);
    writeFileSync(join(projectDir, "rules", "py.md"), `---\ndescription: PY\nglobs: **/*.py\n---\n\n- pep8\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const tsRules = store.getRulesForFile("src/index.ts");
    expect(tsRules).toHaveLength(1);
    expect(tsRules[0]!.description).toBe("TS");

    const pyRules = store.getRulesForFile("main.py");
    expect(pyRules).toHaveLength(1);
    expect(pyRules[0]!.description).toBe("PY");
  });

  it("search finds keyword in memory", () => {
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\nRun pnpm test to test.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const matches = store.search("pnpm");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.match).toContain("pnpm test");
  });

  it("writeAutoMemory creates auto.md", () => {
    const store = new MemoryStore({ userDir, projectDir });
    store.writeAutoMemory({
      trigger: "discovery",
      content: "vitest needs typecheck first",
    });
    expect(existsSync(join(projectDir, "auto.md"))).toBe(true);
    const content = readFileSync(join(projectDir, "auto.md"), "utf-8");
    expect(content).toContain("vitest needs typecheck first");
    expect(content).toContain("type: auto");
  });

  it("writeAutoMemory appends to existing auto.md", () => {
    writeFileSync(join(projectDir, "auto.md"), `---\ntype: auto\n---\n\n### discovery: 2026-07-10\n\nOld entry.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    store.writeAutoMemory({
      trigger: "correction",
      content: "New correction.",
    });
    const content = readFileSync(join(projectDir, "auto.md"), "utf-8");
    expect(content).toContain("Old entry");
    expect(content).toContain("New correction");
  });

  it("writeProjectInstruction creates project.md", () => {
    const store = new MemoryStore({ userDir, projectDir });
    store.writeProjectInstruction("pnpm install", "Build");
    expect(existsSync(join(projectDir, "project.md"))).toBe(true);
    const content = readFileSync(join(projectDir, "project.md"), "utf-8");
    expect(content).toContain("pnpm install");
    expect(content).toContain("## Build");
  });

  it("clear resets session cache", () => {
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\npnpm test.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    store.load();
    store.clear("session");
    // After clear, load should re-read from disk
    const result = store.load();
    expect(result.instructions.length).toBeGreaterThanOrEqual(1);
  });

  it("clear project wipes auto.md", () => {
    writeFileSync(join(projectDir, "auto.md"), `---\ntype: auto\n---\n\n### discovery\n\nSomething.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    store.clear("project");
    const content = readFileSync(join(projectDir, "auto.md"), "utf-8");
    expect(content).toBe("");
  });

  it("exportAll produces markdown", () => {
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\npnpm test.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const exported = store.exportAll();
    expect(exported).toContain("# Helm Memory Export");
    expect(exported).toContain("pnpm test");
  });

  it("importAll appends to project.md", () => {
    const store = new MemoryStore({ userDir, projectDir });
    store.importAll("## Imported\n\nSome imported content.\n");
    const content = readFileSync(join(projectDir, "project.md"), "utf-8");
    expect(content).toContain("Imported");
    expect(content).toContain("Some imported content");
  });

  it("summary returns counts", () => {
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Build\n\npnpm test.\n`);
    writeFileSync(join(projectDir, "auto.md"), `---\ntype: auto\n---\n\n### discovery\n\nSomething.\n`);
    const store = new MemoryStore({ userDir, projectDir });
    const s = store.summary();
    expect(s.instructions).toBeGreaterThanOrEqual(1);
    expect(s.auto).toBeGreaterThanOrEqual(1);
  });

  it("reports errors for malformed files", () => {
    writeFileSync(join(projectDir, "project.md"), "not a real markdown file with frontmatter");
    const store = new MemoryStore({ userDir, projectDir });
    const result = store.load();
    // Should still work - no frontmatter means it's treated as raw content
    expect(result.errors).toHaveLength(0);
  });

  it("respects maxChars limit", () => {
    const store = new MemoryStore({ userDir, projectDir, maxChars: 10 });
    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## Long\n\n${"x".repeat(100)}\n`);
    const result = store.load();
    const sizeError = result.errors.find((e) => e.error.includes("exceeds limit"));
    expect(sizeError).toBeDefined();
  });

  it("invalidate forces reload", () => {
    const store = new MemoryStore({ userDir, projectDir });
    const result1 = store.load();
    expect(result1.instructions).toHaveLength(0);

    writeFileSync(join(projectDir, "project.md"), `---\ntype: instruction\n---\n\n## New\n\nContent.\n`);
    store.invalidate();
    const result2 = store.load();
    expect(result2.instructions.length).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect } from "vitest";
import { matchGlob, matchesGlobs, filterRulesForFile } from "./rules.js";
import type { MemoryRule } from "./types.js";

describe("matchGlob", () => {
  it("matches exact filename", () => {
    expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
  });

  it("matches * wildcard", () => {
    expect(matchGlob("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/index.js", "src/*.ts")).toBe(false);
  });

  it("matches ** wildcard", () => {
    expect(matchGlob("src/deep/nested/file.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("file.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("file.py", "**/*.ts")).toBe(false);
  });

  it("matches ? wildcard", () => {
    expect(matchGlob("file1.ts", "file?.ts")).toBe(true);
    expect(matchGlob("file12.ts", "file?.ts")).toBe(false);
  });

  it("handles Windows-style paths", () => {
    expect(matchGlob("src\\index.ts", "src/*.ts")).toBe(true);
  });
});

describe("matchesGlobs", () => {
  it("returns true for empty globs (match all)", () => {
    expect(matchesGlobs("any/file.ts", [])).toBe(true);
  });

  it("matches against multiple patterns", () => {
    expect(matchesGlobs("file.ts", ["**/*.js", "**/*.ts"])).toBe(true);
    expect(matchesGlobs("file.py", ["**/*.js", "**/*.ts"])).toBe(false);
  });
});

describe("filterRulesForFile", () => {
  function makeRule(globs: string[]): MemoryRule {
    return { source: "test.md", description: "test", globs, content: "rule" };
  }

  it("filters rules by glob", () => {
    const rules = [makeRule(["**/*.ts"]), makeRule(["**/*.py"])];
    const filtered = filterRulesForFile(rules, "index.ts");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.globs).toEqual(["**/*.ts"]);
  });

  it("includes rules with no globs", () => {
    const rules = [makeRule([])];
    const filtered = filterRulesForFile(rules, "any/file.txt");
    expect(filtered).toHaveLength(1);
  });
});

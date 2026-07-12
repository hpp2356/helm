// packages/hooks/src/config.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHookConfig } from "./config.js";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-hooks-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads hooks from project-level .helm/hooks.json", () => {
    const hooksDir = join(tempDir, ".helm");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "pre:tool": [
            { matcher: "bash", handlers: [{ type: "command", command: "./check.sh" }] },
          ],
        },
      }),
    );

    const config = loadHookConfig({ projectRoot: tempDir });
    expect(config.hooks["pre:tool"]).toHaveLength(1);
    expect(config.hooks["pre:tool"]![0]!.matcher).toBe("bash");
  });

  it("loads hooks from global-level ~/.helm/hooks.json", () => {
    const globalDir = join(tempDir, "global", ".helm");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "post:tool": [
            { handlers: [{ type: "command", command: "./log.sh" }] },
          ],
        },
      }),
    );

    const config = loadHookConfig({
      projectRoot: join(tempDir, "nonexistent"),
      homeDir: join(tempDir, "global"),
    });
    expect(config.hooks["post:tool"]).toHaveLength(1);
  });

  it("project-level overrides global-level for same event", () => {
    const projectDir = join(tempDir, ".helm");
    const globalDir = join(tempDir, "global", ".helm");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeFileSync(
      join(projectDir, "hooks.json"),
      JSON.stringify({ hooks: { "pre:tool": [{ handlers: [{ type: "command", command: "/project" }] }] } }),
    );
    writeFileSync(
      join(globalDir, "hooks.json"),
      JSON.stringify({ hooks: { "pre:tool": [{ handlers: [{ type: "command", command: "/global" }] }] } }),
    );

    const config = loadHookConfig({ projectRoot: tempDir, homeDir: join(tempDir, "global") });
    expect(config.hooks["pre:tool"]![0]!.handlers[0]!.command).toBe("/project");
  });

  it("merges different events from global and project", () => {
    const projectDir = join(tempDir, ".helm");
    const globalDir = join(tempDir, "global", ".helm");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeFileSync(
      join(projectDir, "hooks.json"),
      JSON.stringify({ hooks: { "pre:tool": [{ handlers: [{ type: "command", command: "/a" }] }] } }),
    );
    writeFileSync(
      join(globalDir, "hooks.json"),
      JSON.stringify({ hooks: { "post:tool": [{ handlers: [{ type: "command", command: "/b" }] }] } }),
    );

    const config = loadHookConfig({ projectRoot: tempDir, homeDir: join(tempDir, "global") });
    expect(config.hooks["pre:tool"]).toHaveLength(1);
    expect(config.hooks["post:tool"]).toHaveLength(1);
  });

  it("returns empty config when no files exist", () => {
    const config = loadHookConfig({
      projectRoot: join(tempDir, "nonexistent"),
      homeDir: join(tempDir, "nonexistent"),
    });
    expect(config.hooks["pre:tool"]).toBeUndefined();
  });

  it("handles invalid JSON gracefully", () => {
    const hooksDir = join(tempDir, ".helm");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "hooks.json"), "not json!!!");

    const config = loadHookConfig({ projectRoot: tempDir });
    expect(config.hooks["pre:tool"]).toBeUndefined();
  });

  it("skips invalid handler entries", () => {
    const hooksDir = join(tempDir, ".helm");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "pre:tool": [
            { handlers: [{ type: "http", url: "http://x" }] },  // invalid type
            { handlers: [{ type: "command", command: "./ok.sh" }] },
          ],
        },
      }),
    );

    const config = loadHookConfig({ projectRoot: tempDir });
    expect(config.hooks["pre:tool"]).toHaveLength(1);
    expect(config.hooks["pre:tool"]![0]!.handlers[0]!.command).toBe("./ok.sh");
  });
});

// packages/prompt/src/prompt-loader.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptLoader } from "./prompt-loader.js";

describe("prompt-loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-prompt-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadTemplate", () => {
    it("loads template from project-level .helm/prompts/", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "default.tpl"), "Project template {{agent_name}}");

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadTemplate("default");

      expect(result).toBe("Project template {{agent_name}}");
    });

    it("loads template from global-level ~/.helm/prompts/", () => {
      const globalDir = join(tempDir, "global", ".helm", "prompts");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, "default.tpl"), "Global template");

      const loader = new PromptLoader({
        projectRoot: join(tempDir, "nonexistent"),
        homeDir: join(tempDir, "global"),
      });
      const result = loader.loadTemplate("default");

      expect(result).toBe("Global template");
    });

    it("project-level overrides global-level", () => {
      const projectDir = join(tempDir, ".helm", "prompts");
      const globalDir = join(tempDir, "global", ".helm", "prompts");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(projectDir, "default.tpl"), "Project");
      writeFileSync(join(globalDir, "default.tpl"), "Global");

      const loader = new PromptLoader({
        projectRoot: tempDir,
        homeDir: join(tempDir, "global"),
      });
      const result = loader.loadTemplate("default");

      expect(result).toBe("Project");
    });

    it("returns null when template not found", () => {
      const loader = new PromptLoader({
        projectRoot: join(tempDir, "nonexistent"),
        homeDir: join(tempDir, "nonexistent"),
      });
      const result = loader.loadTemplate("default");

      expect(result).toBeNull();
    });

    it("tries provider-specific template first", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "deepseek.tpl"), "DeepSeek template");
      writeFileSync(join(promptsDir, "default.tpl"), "Default template");

      const loader = new PromptLoader({
        projectRoot: tempDir,
        providerName: "deepseek",
      });
      const result = loader.loadTemplate("default");

      expect(result).toBe("DeepSeek template");
    });

    it("falls back to default when provider template not found", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "default.tpl"), "Default template");

      const loader = new PromptLoader({
        projectRoot: tempDir,
        providerName: "deepseek",
      });
      const result = loader.loadTemplate("default");

      expect(result).toBe("Default template");
    });

    it("appends .tpl extension if missing", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "coding.tpl"), "Coding template");

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadTemplate("coding");

      expect(result).toBe("Coding template");
    });
  });

  describe("loadOutputStyle", () => {
    it("loads style from global ~/.helm/output-styles/", () => {
      const stylesDir = join(tempDir, "global", ".helm", "output-styles");
      mkdirSync(stylesDir, { recursive: true });
      writeFileSync(join(stylesDir, "concise.md"), "---\nname: Concise\nkeep-coding-instructions: true\n---\nBe brief.");

      const loader = new PromptLoader({
        projectRoot: join(tempDir, "nonexistent"),
        homeDir: join(tempDir, "global"),
      });
      const result = loader.loadOutputStyle("concise");

      expect(result).not.toBeNull();
      expect(result!.body).toBe("Be brief.");
      expect(result!.keepCodingInstructions).toBe(true);
    });

    it("parses front-matter correctly", () => {
      const stylesDir = join(tempDir, ".helm", "output-styles");
      mkdirSync(stylesDir, { recursive: true });
      writeFileSync(
        join(stylesDir, "detailed.md"),
        "---\nname: Detailed\nkeep-coding-instructions: false\n---\nExplain everything in detail.",
      );

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadOutputStyle("detailed");

      expect(result).not.toBeNull();
      expect(result!.body).toBe("Explain everything in detail.");
      expect(result!.keepCodingInstructions).toBe(false);
    });

    it("handles missing front-matter", () => {
      const stylesDir = join(tempDir, ".helm", "output-styles");
      mkdirSync(stylesDir, { recursive: true });
      writeFileSync(join(stylesDir, "plain.md"), "Just the body content.");

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadOutputStyle("plain");

      expect(result).not.toBeNull();
      expect(result!.body).toBe("Just the body content.");
      expect(result!.keepCodingInstructions).toBe(true);
    });

    it("returns null when style not found", () => {
      const loader = new PromptLoader({
        projectRoot: join(tempDir, "nonexistent"),
        homeDir: join(tempDir, "nonexistent"),
      });
      expect(loader.loadOutputStyle("missing")).toBeNull();
    });
  });

  describe("loadVarsFile", () => {
    it("loads vars.json from project-level", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "vars.json"), '{"project":"helm","lang":"ts"}');

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadVarsFile();

      expect(result).toEqual({ project: "helm", lang: "ts" });
    });

    it("skips non-string values", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "vars.json"), '{"name":"helm","count":42,"flag":true}');

      const loader = new PromptLoader({ projectRoot: tempDir });
      const result = loader.loadVarsFile();

      expect(result).toEqual({ name: "helm" });
    });

    it("returns null when file missing", () => {
      const loader = new PromptLoader({
        projectRoot: join(tempDir, "nonexistent"),
        homeDir: join(tempDir, "nonexistent"),
      });
      expect(loader.loadVarsFile()).toBeNull();
    });

    it("returns null on invalid JSON", () => {
      const promptsDir = join(tempDir, ".helm", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "vars.json"), "not json");

      const loader = new PromptLoader({ projectRoot: tempDir });
      expect(loader.loadVarsFile()).toBeNull();
    });
  });
});

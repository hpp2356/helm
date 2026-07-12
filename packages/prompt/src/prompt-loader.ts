// packages/prompt/src/prompt-loader.ts

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Prompt loader with layered file resolution.
 *
 * Lookup order:
 *   1. Project-level: .helm/prompts/<name>.tpl
 *   2. Global-level:  ~/.helm/prompts/<name>.tpl
 *   3. Built-in default
 *
 * Per-provider: first try <provider>.tpl, fallback to default.tpl.
 */

export interface PromptLoaderOptions {
  /** Project root directory (for .helm/prompts/). */
  projectRoot?: string;
  /** Home directory (for ~/.helm/prompts/). */
  homeDir?: string;
  /** Current provider name (for per-provider templates). */
  providerName?: string;
}

export class PromptLoader {
  private projectRoot: string;
  private homeDir: string;
  private providerName: string;

  constructor(options: PromptLoaderOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.homeDir = options.homeDir ?? process.env.HOME ?? "/tmp";
    this.providerName = options.providerName ?? "default";
  }

  /**
   * Load a prompt template by name.
   * Tries provider-specific first, then falls back to default.
   *
   * @param name — template name (without .tpl extension), e.g. "default", "coding"
   * @returns template string, or null if not found
   */
  loadTemplate(name: string): string | null {
    // Try provider-specific template first
    const providerTemplate = this.resolveTemplate(this.providerName);
    if (providerTemplate) return providerTemplate;

    // Fallback to requested name
    if (name !== this.providerName) {
      return this.resolveTemplate(name);
    }

    return null;
  }

  /**
   * Resolve a template name to file content.
   * Searches project-level first, then global-level.
   */
  private resolveTemplate(name: string): string | null {
    const fileName = name.endsWith(".tpl") ? name : `${name}.tpl`;

    // Project-level
    const projectPath = resolve(this.projectRoot, ".helm", "prompts", fileName);
    if (existsSync(projectPath)) {
      return readFileSync(projectPath, "utf-8");
    }

    // Global-level
    const globalPath = resolve(this.homeDir, ".helm", "prompts", fileName);
    if (existsSync(globalPath)) {
      return readFileSync(globalPath, "utf-8");
    }

    return null;
  }

  /**
   * Load an output style by name from ~/.helm/output-styles/.
   *
   * @param name — style name (without .md extension)
   * @returns parsed style meta + body, or null
   */
  loadOutputStyle(name: string): { body: string; keepCodingInstructions: boolean } | null {
    const fileName = name.endsWith(".md") ? name : `${name}.md`;

    // Try project-level first
    const projectPath = resolve(this.projectRoot, ".helm", "output-styles", fileName);
    if (existsSync(projectPath)) {
      return this.parseOutputStyle(readFileSync(projectPath, "utf-8"));
    }

    // Global-level
    const globalPath = resolve(this.homeDir, ".helm", "output-styles", fileName);
    if (existsSync(globalPath)) {
      return this.parseOutputStyle(readFileSync(globalPath, "utf-8"));
    }

    return null;
  }

  /**
   * Parse output style markdown with optional YAML front-matter.
   *
   * Format:
   *   ---
   *   name: Style Name
   *   description: What it does
   *   keep-coding-instructions: true
   *   ---
   *   Body content here...
   */
  private parseOutputStyle(content: string): { body: string; keepCodingInstructions: boolean } {
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!frontMatterMatch) {
      return { body: content.trim(), keepCodingInstructions: true };
    }

    const frontMatter = frontMatterMatch[1]!;
    const body = frontMatterMatch[2]!.trim();
    let keepCodingInstructions = true;

    // Simple YAML parsing for keep-coding-instructions
    const keepMatch = frontMatter.match(/keep-coding-instructions:\s*(true|false)/i);
    if (keepMatch) {
      keepCodingInstructions = keepMatch[1]!.toLowerCase() === "true";
    }

    return { body, keepCodingInstructions };
  }

  /**
   * Load variables from a vars.json file.
   * Searches project-level first, then global-level.
   */
  loadVarsFile(): Record<string, string> | null {
    // Project-level
    const projectPath = resolve(this.projectRoot, ".helm", "prompts", "vars.json");
    if (existsSync(projectPath)) {
      return this.parseVarsFile(projectPath);
    }

    // Global-level
    const globalPath = resolve(this.homeDir, ".helm", "prompts", "vars.json");
    if (existsSync(globalPath)) {
      return this.parseVarsFile(globalPath);
    }

    return null;
  }

  private parseVarsFile(filePath: string): Record<string, string> | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const vars = JSON.parse(content) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    } catch {
      return null;
    }
  }
}

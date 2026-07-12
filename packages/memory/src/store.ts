// packages/memory/src/store.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type {
  MemoryScope,
  MemoryEntry,
  MemoryRule,
  MemoryLoadResult,
  MemoryStoreOptions,
  AutoMemoryWrite,
} from "./types.js";

const DEFAULT_MAX_CHARS = 25 * 1024; // 25KB
const DEFAULT_MAX_LINES = 200;

function userMemoryDir(): string {
  return resolve(process.env.HOME ?? "/tmp", ".helm", "memory");
}

function projectMemoryDir(): string {
  return resolve(process.cwd(), ".helm", "memory");
}

/**
 * Central memory store.
 *
 * Loads instruction, auto, and rule memories from disk.
 * Provides write, search, clear, export/import operations.
 */
export class MemoryStore {
  private userDir: string;
  private projectDir: string;
  private maxChars: number;
  private maxLines: number;
  private loaded: MemoryLoadResult | null = null;

  constructor(options: MemoryStoreOptions = {}) {
    this.userDir = options.userDir ?? userMemoryDir();
    this.projectDir = options.projectDir ?? projectMemoryDir();
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  }

  /** Load all memory files from disk. Returns cached result if already loaded. */
  load(): MemoryLoadResult {
    if (this.loaded) return this.loaded;

    const result: MemoryLoadResult = {
      instructions: [],
      auto: [],
      rules: [],
      totalLines: 0,
      errors: [],
    };

    // Load user-level memories
    this.loadFile(this.userDir, "user.md", "user", result);
    // Load project-level memories
    this.loadFile(this.projectDir, "project.md", "project", result);
    // Load auto memories
    this.loadFile(this.projectDir, "auto.md", "project", result);
    // Load rules
    this.loadRules(result);

    // Check size limits
    const totalChars = [...result.instructions, ...result.auto]
      .map((e) => e.content.length)
      .reduce((a, b) => a + b, 0);
    if (totalChars > this.maxChars) {
      result.errors.push({
        file: "(size check)",
        error: `Memory size ${totalChars} exceeds limit ${this.maxChars} characters`,
      });
    }
    if (result.totalLines > this.maxLines) {
      result.errors.push({
        file: "(size check)",
        error: `Memory lines ${result.totalLines} exceeds limit ${this.maxLines} lines`,
      });
    }

    this.loaded = result;
    return result;
  }

  /** Get instruction memories as a single string for system prompt injection. */
  getInstructionText(): string {
    const result = this.load();
    const parts: string[] = [];
    for (const entry of result.instructions) {
      if (entry.heading) {
        parts.push(`## ${entry.heading}`);
      }
      parts.push(entry.content);
    }
    return parts.join("\n\n").trim();
  }

  /** Get auto memories as a single string. */
  getAutoText(): string {
    const result = this.load();
    const parts: string[] = [];
    for (const entry of result.auto) {
      if (entry.heading) {
        parts.push(`## ${entry.heading}`);
      }
      parts.push(entry.content);
    }
    return parts.join("\n\n").trim();
  }

  /** Get rules matching a file path. */
  getRulesForFile(filePath: string): MemoryRule[] {
    const result = this.load();
    return result.rules.filter((rule) => matchesGlobs(filePath, rule.globs));
  }

  /** Write an auto-memory entry to project auto.md. */
  writeAutoMemory(write: AutoMemoryWrite): void {
    const autoPath = join(this.projectDir, "auto.md");
    ensureDir(this.projectDir);

    let existing = "";
    if (existsSync(autoPath)) {
      existing = readFileSync(autoPath, "utf-8");
    }

    const timestamp = new Date().toISOString().split("T")[0];
    const section = `\n\n### ${write.trigger}: ${timestamp}\n\n${write.content}${write.context ? `\n\nContext: ${write.context}` : ""}\n`;

    // Update frontmatter if exists, or create new
    if (existing.startsWith("---")) {
      const endIdx = existing.indexOf("---", 3);
      if (endIdx !== -1) {
        const frontmatter = existing.slice(0, endIdx + 3);
        const body = existing.slice(endIdx + 3);
        // Update updated field
        const updatedFrontmatter = frontmatter.replace(
          /updated: .*/,
          `updated: ${timestamp}`,
        );
        writeFileSync(autoPath, updatedFrontmatter + body + section, "utf-8");
      } else {
        writeFileSync(autoPath, existing + section, "utf-8");
      }
    } else {
      const header = `---\ntype: auto\nproject: ${this.getProjectName()}\ncreated: ${timestamp}\nupdated: ${timestamp}\n---\n`;
      writeFileSync(autoPath, header + (existing || "\n") + section, "utf-8");
    }

    // Invalidate cache
    this.loaded = null;
  }

  /** Write a project instruction memory. */
  writeProjectInstruction(content: string, heading?: string): void {
    const projectPath = join(this.projectDir, "project.md");
    ensureDir(this.projectDir);

    let existing = "";
    if (existsSync(projectPath)) {
      existing = readFileSync(projectPath, "utf-8");
    }

    const timestamp = new Date().toISOString().split("T")[0];
    const section = heading ? `\n\n## ${heading}\n\n${content}\n` : `\n\n${content}\n`;

    if (existing.startsWith("---")) {
      const endIdx = existing.indexOf("---", 3);
      if (endIdx !== -1) {
        const frontmatter = existing.slice(0, endIdx + 3);
        const body = existing.slice(endIdx + 3);
        const updatedFrontmatter = frontmatter.replace(
          /updated: .*/,
          `updated: ${timestamp}`,
        );
        writeFileSync(projectPath, updatedFrontmatter + body + section, "utf-8");
      } else {
        writeFileSync(projectPath, existing + section, "utf-8");
      }
    } else {
      const header = `---\ntype: instruction\nproject: ${this.getProjectName()}\ncreated: ${timestamp}\nupdated: ${timestamp}\n---\n`;
      writeFileSync(projectPath, header + (existing || "\n") + section, "utf-8");
    }

    this.loaded = null;
  }

  /** Search memory content by keyword (case-insensitive). */
  search(keyword: string): Array<{ entry: MemoryEntry | MemoryRule; match: string }> {
    const result = this.load();
    const lower = keyword.toLowerCase();
    const matches: Array<{ entry: MemoryEntry | MemoryRule; match: string }> = [];

    for (const entry of [...result.instructions, ...result.auto]) {
      const content = entry.content.toLowerCase();
      if (content.includes(lower)) {
        const lines = entry.content.split("\n");
        const matchLine = lines.find((l) => l.toLowerCase().includes(lower));
        matches.push({ entry, match: matchLine?.trim() ?? entry.content.slice(0, 80) });
      }
    }

    for (const rule of result.rules) {
      const content = rule.content.toLowerCase();
      if (content.includes(lower)) {
        const lines = rule.content.split("\n");
        const matchLine = lines.find((l) => l.toLowerCase().includes(lower));
        matches.push({ entry: rule, match: matchLine?.trim() ?? rule.content.slice(0, 80) });
      }
    }

    return matches;
  }

  /** Clear all memory for a given scope. */
  clear(scope: "session" | "project" | "all"): void {
    if (scope === "session" || scope === "all") {
      this.loaded = null;
    }
    if (scope === "project" || scope === "all") {
      const autoPath = join(this.projectDir, "auto.md");
      if (existsSync(autoPath)) {
        writeFileSync(autoPath, "", "utf-8");
      }
      this.loaded = null;
    }
  }

  /** Export all memory as a single markdown string. */
  exportAll(): string {
    const result = this.load();
    const parts: string[] = ["# Helm Memory Export\n"];

    if (result.instructions.length > 0) {
      parts.push("## Instructions\n");
      for (const entry of result.instructions) {
        if (entry.heading) parts.push(`### ${entry.heading}`);
        parts.push(entry.content);
        parts.push("");
      }
    }

    if (result.auto.length > 0) {
      parts.push("## Auto Memory\n");
      for (const entry of result.auto) {
        if (entry.heading) parts.push(`### ${entry.heading}`);
        parts.push(entry.content);
        parts.push("");
      }
    }

    if (result.rules.length > 0) {
      parts.push("## Rules\n");
      for (const rule of result.rules) {
        parts.push(`### ${rule.description || basename(rule.source)}`);
        parts.push(rule.content);
        parts.push("");
      }
    }

    return parts.join("\n");
  }

  /** Import memory from a markdown string (appends to project memory). */
  importAll(content: string): void {
    const projectPath = join(this.projectDir, "project.md");
    ensureDir(this.projectDir);

    const timestamp = new Date().toISOString().split("T")[0];
    const header = `---\ntype: instruction\nproject: ${this.getProjectName()}\ncreated: ${timestamp}\nupdated: ${timestamp}\n---\n\n`;

    if (existsSync(projectPath)) {
      const existing = readFileSync(projectPath, "utf-8");
      writeFileSync(projectPath, existing + "\n\n" + content, "utf-8");
    } else {
      writeFileSync(projectPath, header + content, "utf-8");
    }

    this.loaded = null;
  }

  /** Get a summary of loaded memory. */
  summary(): { instructions: number; auto: number; rules: number; totalLines: number; errors: number } {
    const result = this.load();
    return {
      instructions: result.instructions.length,
      auto: result.auto.length,
      rules: result.rules.length,
      totalLines: result.totalLines,
      errors: result.errors.length,
    };
  }

  /** Force reload from disk on next access. */
  invalidate(): void {
    this.loaded = null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private loadFile(dir: string, filename: string, scope: "user" | "project", result: MemoryLoadResult): void {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n");
      result.totalLines += lines.length;

      const { frontmatter, body } = parseFrontmatter(raw);
      const sections = splitSections(body);

      for (const section of sections) {
        const entry: MemoryEntry = {
          id: `${filePath}#${section.heading ?? "root"}`,
          scope,
          type: (frontmatter.type as "instruction" | "auto") ?? "instruction",
          source: filePath,
          heading: section.heading,
          content: section.content.trim(),
          metadata: frontmatter,
          lastModified: Date.now(),
        };
        if (entry.content) {
          if (entry.type === "auto") {
            result.auto.push(entry);
          } else {
            result.instructions.push(entry);
          }
        }
      }
    } catch (err) {
      result.errors.push({
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadRules(result: MemoryLoadResult): void {
    const rulesDir = join(this.projectDir, "rules");
    if (!existsSync(rulesDir)) return;

    try {
      const entries = readdirSync(rulesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(rulesDir, entry.name);

        try {
          const raw = readFileSync(filePath, "utf-8");
          const lines = raw.split("\n");
          result.totalLines += lines.length;

          const { frontmatter, body } = parseFrontmatter(raw);
          const globs = frontmatter.globs
            ? frontmatter.globs.split(",").map((g: string) => g.trim())
            : [];

          result.rules.push({
            source: filePath,
            description: frontmatter.description ?? entry.name,
            globs,
            content: body.trim(),
          });
        } catch (err) {
          result.errors.push({
            file: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      result.errors.push({
        file: rulesDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getProjectName(): string {
    return basename(process.cwd());
  }
}

// ── Utility functions ───────────────────────────────────────────────────────

/** Parse YAML frontmatter from markdown content. */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};

  if (!raw.startsWith("---")) {
    return { frontmatter, body: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter, body: raw };
  }

  const yamlContent = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();

  for (const line of yamlContent.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/** Split markdown body into sections by headings. */
function splitSections(body: string): Array<{ heading: string | null; content: string }> {
  if (!body) return [{ heading: null, content: "" }];

  const sections: Array<{ heading: string | null; content: string }> = [];
  const lines = body.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) {
      if (currentLines.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n"),
        });
      }
      currentHeading = match[2] ?? null;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n"),
    });
  }

  return sections;
}

/** Check if a file path matches any of the glob patterns. */
function matchesGlobs(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) return true; // no globs = match all

  for (const glob of globs) {
    if (matchGlob(filePath, glob)) return true;
  }
  return false;
}

/** Simple glob matching (supports **, *, ?). */
function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Build regex from glob pattern character by character
  let regexStr = "";
  let i = 0;
  while (i < normalizedPattern.length) {
    const c = normalizedPattern[i];
    if (c === "*" && normalizedPattern[i + 1] === "*") {
      // ** — match any number of path segments (including zero)
      if (normalizedPattern[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      // * — match within a single segment (no slash)
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      // ? — match a single non-slash character
      regexStr += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      // Escape regex special characters
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalizedPath);
}

/** Ensure a directory exists. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

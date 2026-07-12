// packages/memory/src/types.ts

/** Memory scope levels. */
export type MemoryScope = "user" | "project" | "session";

/** Memory entry type. */
export type MemoryType = "instruction" | "auto" | "rule";

/** A single memory entry parsed from a markdown file. */
export interface MemoryEntry {
  /** Unique ID (derived from file path + heading). */
  id: string;
  /** Memory scope. */
  scope: MemoryScope;
  /** Memory type. */
  type: MemoryType;
  /** Source file path. */
  source: string;
  /** Section heading (if any). */
  heading: string | null;
  /** Content body (markdown). */
  content: string;
  /** Frontmatter metadata. */
  metadata: Record<string, string>;
  /** Last modified timestamp (ms since epoch). */
  lastModified: number;
}

/** A memory rule with glob matching. */
export interface MemoryRule {
  /** Rule file path. */
  source: string;
  /** Description from frontmatter. */
  description: string;
  /** Glob patterns to match file paths. */
  globs: string[];
  /** Rule content (markdown body). */
  content: string;
}

/** Result of loading all memory files. */
export interface MemoryLoadResult {
  /** Instruction memories (user.md, project.md). */
  instructions: MemoryEntry[];
  /** Auto memories (auto.md). */
  auto: MemoryEntry[];
  /** Rules (rules/*.md). */
  rules: MemoryRule[];
  /** Total lines loaded. */
  totalLines: number;
  /** Errors encountered during loading. */
  errors: Array<{ file: string; error: string }>;
}

/** Options for the MemoryStore. */
export interface MemoryStoreOptions {
  /** User-level memory directory (~/.helm/memory/). */
  userDir?: string;
  /** Project-level memory directory (.helm/memory/). */
  projectDir?: string;
  /** Maximum total size in characters before warning. */
  maxChars?: number;
  /** Maximum lines before warning. */
  maxLines?: number;
}

/** Auto memory trigger types. */
export type AutoMemoryTrigger = "correction" | "discovery" | "preference" | "debug_success";

/** A pending auto-memory write. */
export interface AutoMemoryWrite {
  /** Trigger type. */
  trigger: AutoMemoryTrigger;
  /** Content to record. */
  content: string;
  /** Optional context string. */
  context?: string;
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "@helm/core";
import { RiskLevel } from "@helm/core";
import { WorkspaceGuard } from "./workspace-guard.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const BINARY_CHECK_BYTES = 4096;

function isBinary(filePath: string): boolean {
  const buf = Buffer.alloc(BINARY_CHECK_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function formatDirEntry(
  entry: fs.Dirent,
  dirPath: string,
): Array<{ name: string; type: "file" | "directory" | "symlink"; size: number }> {
  const results: Array<{
    name: string;
    type: "file" | "directory" | "symlink";
    size: number;
  }> = [];

  try {
    if (entry.isSymbolicLink()) {
      results.push({ name: entry.name, type: "symlink", size: 0 });
    } else if (entry.isDirectory()) {
      results.push({ name: entry.name, type: "directory", size: 0 });
    } else if (entry.isFile()) {
      const stat = fs.statSync(path.join(dirPath, entry.name));
      results.push({ name: entry.name, type: "file", size: stat.size });
    }
  } catch {
    results.push({ name: entry.name, type: "file", size: 0 });
  }

  return results;
}

// ── Glob ──────────────────────────────────────────────────────────────────

function matchGlob(pattern: string, entryName: string): boolean {
  // Simple glob: support *, **, ? and character classes [abc]
  return minimatch(entryName, pattern);
}

function minimatch(name: string, pattern: string): boolean {
  // Translate glob pattern to regex
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including path separators
        regexStr += ".*";
        i += 2;
        // skip trailing /
        if (pattern[i] === "/") i++;
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regexStr += "\\[";
        i++;
      } else {
        regexStr += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if ("(){}^$|.+\\".includes(ch)) {
      regexStr += "\\" + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`).test(name);
}

function globWalk(
  baseDir: string,
  segments: string[],
): string[] {
  const results: string[] = [];

  if (segments.length === 0) {
    return [baseDir];
  }

  const [head, ...tail] = segments;

  if (head === "**") {
    // Match everything recursively
    results.push(...globWalk(baseDir, tail));
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try {
            const subPath = path.join(baseDir, entry.name);
            results.push(...globWalk(subPath, segments));
          } catch {
            // skip inaccessible
          }
        }
      }
    } catch {
      // skip
    }
    return results;
  }

  // Match current level
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (matchGlob(head, entry.name)) {
        if (tail.length === 0) {
          results.push(path.join(baseDir, entry.name));
        } else if (entry.isDirectory() || entry.isSymbolicLink()) {
          try {
            const subPath = path.join(baseDir, entry.name);
            results.push(...globWalk(subPath, tail));
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // skip
  }

  return results;
}

function runGlob(pattern: string, baseDir: string): string[] {
  const segments = pattern.split("/").filter((s): s is string => s.length > 0);
  // Handle patterns without directory separators (simple filename match)
  return globWalk(baseDir, segments.length > 0 ? segments : []);
}

// ── Tool factories ────────────────────────────────────────────────────────

export interface FileToolOptions {
  guard: WorkspaceGuard;
}

export function createReadTool(opts: FileToolOptions): Tool {
  return {
    name: "read",
    description:
      "Read a file from the workspace. Supports offset and limit for partial reads.",
    riskLevel: RiskLevel.LOW,
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to read" },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
      },
      required: ["filePath"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = String(args.filePath ?? "");
      if (!rawPath) return "Error: filePath is required";

      let resolved: string;
      try {
        resolved = opts.guard.validate(rawPath);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          return `Error: "${rawPath}" is not a file`;
        }
      } catch {
        return `Error: file not found: "${rawPath}"`;
      }

      if (isBinary(resolved)) {
        return `Error: "${rawPath}" appears to be a binary file and cannot be read`;
      }

      try {
        const content = fs.readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const totalLines = lines.length;

        let offset = 0;
        let limit = totalLines;

        if (args.offset !== undefined) {
          offset = Math.max(0, Number(args.offset) - 1);
        }
        if (args.limit !== undefined) {
          limit = Number(args.limit);
        }

        const sliced = lines.slice(offset, offset + limit).join("\n");

        return JSON.stringify({
          content: sliced,
          totalLines,
          path: rawPath,
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createWriteTool(opts: FileToolOptions): Tool {
  return {
    name: "write",
    description: "Create or overwrite a file in the workspace.",
    riskLevel: RiskLevel.HIGH,
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["filePath", "content"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = String(args.filePath ?? "");
      const content = String(args.content ?? "");

      if (!rawPath) return "Error: filePath is required";

      let resolved: string;
      try {
        resolved = opts.guard.validate(rawPath);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Reject directories
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          return `Error: "${rawPath}" is a directory, not a file`;
        }
      } catch {
        // doesn't exist — that's fine
      }

      try {
        // Auto-create parent directories
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, content, "utf-8");
        const bytesWritten = Buffer.byteLength(content, "utf-8");
        return JSON.stringify({ path: rawPath, bytesWritten });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createEditTool(opts: FileToolOptions): Tool {
  return {
    name: "edit",
    description:
      "Find and replace text in an existing file. oldString must match exactly (whitespace-sensitive).",
    riskLevel: RiskLevel.HIGH,
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to edit" },
        oldString: { type: "string", description: "Exact string to find" },
        newString: { type: "string", description: "Replacement string" },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences (default false)",
        },
      },
      required: ["filePath", "oldString", "newString"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = String(args.filePath ?? "");
      const oldString = String(args.oldString ?? "");
      const newString = String(args.newString ?? "");
      const replaceAll = args.replaceAll === true;

      if (!rawPath) return "Error: filePath is required";
      if (!oldString) return "Error: oldString is required";

      let resolved: string;
      try {
        resolved = opts.guard.validate(rawPath);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      let content: string;
      try {
        content = fs.readFileSync(resolved, "utf-8");
      } catch {
        return `Error: file not found: "${rawPath}"`;
      }

      if (!content.includes(oldString)) {
        return `Error: string not found in "${rawPath}"`;
      }

      const count = content.split(oldString).length - 1;

      if (count > 1 && !replaceAll) {
        return `Error: found ${count} matches for oldString in "${rawPath}". Use replaceAll: true to replace all, or make oldString more specific.`;
      }

      const replaced = content.replaceAll(oldString, newString);

      try {
        fs.writeFileSync(resolved, replaced, "utf-8");
        return JSON.stringify({
          path: rawPath,
          replaced: true,
          matchCount: replaceAll ? count : 1,
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createLsTool(opts: FileToolOptions): Tool {
  return {
    name: "ls",
    description: "List directory contents. Defaults to workspace root.",
    riskLevel: RiskLevel.LOW,
    parameters: {
      type: "object",
      properties: {
        dirPath: {
          type: "string",
          description: "Directory path (defaults to workspace root)",
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath =
        args.dirPath !== undefined ? String(args.dirPath) : ".";

      let resolved: string;
      try {
        resolved = opts.guard.validate(rawPath);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          return `Error: "${rawPath}" is not a directory`;
        }
      } catch {
        return `Error: directory not found: "${rawPath}"`;
      }

      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const results = entries.flatMap((e) => formatDirEntry(e, resolved));
        return JSON.stringify({ entries: results, path: rawPath });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createGlobTool(opts: FileToolOptions): Tool {
  return {
    name: "glob",
    description: "Find files matching a glob pattern in the workspace.",
    riskLevel: RiskLevel.LOW,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g., **​/*.ts)" },
        dirPath: {
          type: "string",
          description: "Directory to search from (defaults to workspace root)",
        },
      },
      required: ["pattern"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const pattern = String(args.pattern ?? "");
      const rawDir =
        args.dirPath !== undefined ? String(args.dirPath) : ".";

      if (!pattern) return "Error: pattern is required";

      let resolvedDir: string;
      try {
        resolvedDir = opts.guard.validate(rawDir);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const matches = runGlob(pattern, resolvedDir);
        // Filter results to workspace
        const safeMatches = matches.filter((m) => {
          try {
            opts.guard.validate(m);
            return true;
          } catch {
            return false;
          }
        });
        // Make paths relative to workspace root
        const relativeMatches = safeMatches.map(
          (m) => path.relative(opts.guard.root, m),
        );
        return JSON.stringify({
          matches: relativeMatches,
          pattern,
          count: relativeMatches.length,
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── Registration helper ───────────────────────────────────────────────────

export function registerFileTools(
  toolRuntime: { register(tool: Tool): void },
  workspaceRoot: string,
): WorkspaceGuard {
  const guard = new WorkspaceGuard(workspaceRoot);
  const opts: FileToolOptions = { guard };

  toolRuntime.register(createReadTool(opts));
  toolRuntime.register(createWriteTool(opts));
  toolRuntime.register(createEditTool(opts));
  toolRuntime.register(createLsTool(opts));
  toolRuntime.register(createGlobTool(opts));

  return guard;
}

// ── Risk level metadata ───────────────────────────────────────────────────

export const FILE_TOOL_RISK_LEVELS: Record<string, RiskLevel> = {
  read: RiskLevel.LOW,
  ls: RiskLevel.LOW,
  glob: RiskLevel.LOW,
  write: RiskLevel.HIGH,
  edit: RiskLevel.HIGH,
};

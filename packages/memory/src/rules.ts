// packages/memory/src/rules.ts
import type { MemoryRule } from "./types.js";

/** Simple glob matching (supports **, *, ?). */
export function matchGlob(filePath: string, pattern: string): boolean {
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

/** Check if a file path matches any of the glob patterns. If no globs, matches all. */
export function matchesGlobs(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) return true;
  for (const glob of globs) {
    if (matchGlob(filePath, glob)) return true;
  }
  return false;
}

/** Filter rules that apply to a given file path. */
export function filterRulesForFile(rules: MemoryRule[], filePath: string): MemoryRule[] {
  return rules.filter((rule) => matchesGlobs(filePath, rule.globs));
}

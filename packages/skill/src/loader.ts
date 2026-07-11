// packages/skill/src/loader.ts
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Skill } from "./types.js";

const GLOBAL_SKILL_DIR = resolve(process.env.HOME ?? "/tmp", ".helm", "skills");

function projectSkillDir(): string {
  return resolve(process.cwd(), ".helm", "skills");
}

/** Result of loading a single skill file. */
export interface SkillLoadResult {
  skillName: string;
  status: "loaded" | "failed";
  error?: string;
}

/** Load result with the actual Skill object. */
export interface SkillLoadEntry {
  skill?: Skill;
  result: SkillLoadResult;
}

/**
 * Scan skill directories for .ts/.js files, dynamic-import each,
 * and return Skill objects.
 *
 * Each file must have an ESM default export conforming to the Skill interface.
 */
export async function loadUserSkills(extraDirs?: string[]): Promise<SkillLoadEntry[]> {
  const dirs: string[] = [];
  const projDir = projectSkillDir();
  if (existsSync(projDir)) dirs.push(projDir);
  if (existsSync(GLOBAL_SKILL_DIR)) dirs.push(GLOBAL_SKILL_DIR);
  if (extraDirs) {
    for (const d of extraDirs) {
      if (existsSync(d) && !dirs.includes(d)) dirs.push(d);
    }
  }

  const entries: SkillLoadEntry[] = [];

  for (const dir of dirs) {
    const files = scanSkillFiles(dir);
    for (const file of files) {
      const entry = await loadSkillFile(file);
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Load a single skill file. Returns the Skill object or error.
 */
export async function loadSkillFile(filePath: string): Promise<SkillLoadEntry> {
  const fileName = filePath.split("/").pop() ?? filePath;
  try {
    const imported = await import(filePath);
    const mod = imported.default ?? imported;

    if (typeof mod !== "object" || mod === null) {
      return { result: { skillName: fileName, status: "failed", error: "default export must be an object" } };
    }

    if (typeof mod.name !== "string" || mod.name.trim() === "") {
      return { result: { skillName: fileName, status: "failed", error: 'missing required field "name"' } };
    }
    if (typeof mod.handler !== "function") {
      return { result: { skillName: fileName, status: "failed", error: 'missing required field "handler" (must be a function)' } };
    }

    const skill: Skill = {
      name: mod.name.startsWith("/") ? mod.name.slice(1) : mod.name,
      description: typeof mod.description === "string" ? mod.description : "User skill",
      handler: mod.handler,
    };

    return { skill, result: { skillName: skill.name, status: "loaded" } };
  } catch (err) {
    return {
      result: {
        skillName: fileName,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Scan a directory for skill files (.ts, .js).
 * Returns absolute paths.
 */
function scanSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js")) && !e.name.startsWith("."))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

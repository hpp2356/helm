// packages/plugin/src/manifest.ts
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginManifest } from "./types.js";
import { PluginError } from "./types.js";

const MANIFEST_FILE = "plugin.json";

/**
 * Read and validate a plugin manifest from a directory.
 *
 * Looks for `plugin.json` in the given directory path.
 * Returns the parsed manifest or throws PluginError on validation failure.
 */
export function readManifest(pluginDir: string): PluginManifest {
  const manifestPath = resolve(pluginDir, MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    throw new PluginError(
      `manifest not found: ${manifestPath}`,
      pluginDir,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (err) {
    throw new PluginError(
      `failed to read manifest: ${err instanceof Error ? err.message : String(err)}`,
      pluginDir,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PluginError(
      `invalid JSON in manifest: ${err instanceof Error ? err.message : String(err)}`,
      pluginDir,
      err,
    );
  }

  return validateManifest(parsed, pluginDir);
}

/**
 * Validate a parsed JSON object as a PluginManifest.
 * Normalizes optional fields and checks required fields.
 */
export function validateManifest(raw: unknown, pluginDir: string): PluginManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError("manifest must be a JSON object", pluginDir);
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new PluginError('manifest missing required field "name"', pluginDir);
  }
  if (typeof obj.version !== "string" || obj.version.trim() === "") {
    throw new PluginError('manifest missing required field "version"', pluginDir);
  }

  // Validate plugin name format (lowercase, hyphens, no spaces)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(obj.name)) {
    throw new PluginError(
      `invalid plugin name "${obj.name}": must be lowercase alphanumeric with hyphens`,
      pluginDir,
    );
  }

  const manifest: PluginManifest = {
    name: obj.name,
    version: obj.version,
  };

  // Optional fields
  if (typeof obj.description === "string") {
    manifest.description = obj.description;
  }
  if (typeof obj.main === "string") {
    manifest.main = obj.main;
  }

  // Tools array
  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) {
      throw new PluginError('"tools" must be an array', pluginDir);
    }
    manifest.tools = obj.tools.map((t, i) => validateToolDef(t, i, pluginDir));
  }

  // Skills array
  if (obj.skills !== undefined) {
    if (!Array.isArray(obj.skills)) {
      throw new PluginError('"skills" must be an array', pluginDir);
    }
    manifest.skills = obj.skills.map((s, i) => validateSkillDef(s, i, pluginDir));
  }

  // Prompts array
  if (obj.prompts !== undefined) {
    if (!Array.isArray(obj.prompts)) {
      throw new PluginError('"prompts" must be an array', pluginDir);
    }
    manifest.prompts = obj.prompts.map((p, i) => validatePromptDef(p, i, pluginDir));
  }

  // Config array
  if (obj.config !== undefined) {
    if (!Array.isArray(obj.config)) {
      throw new PluginError('"config" must be an array', pluginDir);
    }
    manifest.config = obj.config.map((c, i) => validateConfigDef(c, i, pluginDir));
  }

  return manifest;
}

function validateToolDef(
  raw: unknown,
  index: number,
  pluginDir: string,
): PluginManifest["tools"] extends (infer T)[] | undefined ? T : never {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(`tools[${index}] must be an object`, pluginDir);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new PluginError(`tools[${index}] missing required field "name"`, pluginDir);
  }
  const def: { name: string; description?: string; parameters?: Record<string, unknown>; riskLevel?: string } = {
    name: obj.name,
  };
  if (typeof obj.description === "string") def.description = obj.description;
  if (typeof obj.parameters === "object" && obj.parameters !== null) {
    def.parameters = obj.parameters as Record<string, unknown>;
  }
  if (typeof obj.riskLevel === "string") def.riskLevel = obj.riskLevel;
  return def as PluginManifest["tools"] extends (infer T)[] | undefined ? T : never;
}

function validateSkillDef(
  raw: unknown,
  index: number,
  pluginDir: string,
): PluginManifest["skills"] extends (infer T)[] | undefined ? T : never {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(`skills[${index}] must be an object`, pluginDir);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new PluginError(`skills[${index}] missing required field "name"`, pluginDir);
  }
  const def: { name: string; description?: string } = { name: obj.name };
  if (typeof obj.description === "string") def.description = obj.description;
  return def as PluginManifest["skills"] extends (infer T)[] | undefined ? T : never;
}

function validatePromptDef(
  raw: unknown,
  index: number,
  pluginDir: string,
): PluginManifest["prompts"] extends (infer T)[] | undefined ? T : never {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(`prompts[${index}] must be an object`, pluginDir);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new PluginError(`prompts[${index}] missing required field "name"`, pluginDir);
  }
  const def: { name: string; description?: string; template?: string } = { name: obj.name };
  if (typeof obj.description === "string") def.description = obj.description;
  if (typeof obj.template === "string") def.template = obj.template;
  return def as PluginManifest["prompts"] extends (infer T)[] | undefined ? T : never;
}

function validateConfigDef(
  raw: unknown,
  index: number,
  pluginDir: string,
): PluginManifest["config"] extends (infer T)[] | undefined ? T : never {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(`config[${index}] must be an object`, pluginDir);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.key !== "string" || obj.key.trim() === "") {
    throw new PluginError(`config[${index}] missing required field "key"`, pluginDir);
  }
  const def: { key: string; description?: string; required?: boolean; default?: unknown } = {
    key: obj.key,
  };
  if (typeof obj.description === "string") def.description = obj.description;
  if (typeof obj.required === "boolean") def.required = obj.required;
  if (obj.default !== undefined) def.default = obj.default;
  return def as PluginManifest["config"] extends (infer T)[] | undefined ? T : never;
}

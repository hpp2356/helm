// packages/plugin/src/installer.ts
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PluginError } from "./types.js";

const GLOBAL_PLUGIN_DIR = resolve(process.env.HOME ?? "/tmp", ".helm", "plugins");

/**
 * Install a plugin from an npm package into the plugin directory.
 *
 * Runs `npm install --prefix <dir> <pkg>` to install the package,
 * then validates that the installed directory has a plugin.json.
 */
export async function installPlugin(
  npmPackage: string,
  targetDir?: string,
): Promise<{ name: string; version: string; path: string }> {
  const pluginDir = targetDir ?? GLOBAL_PLUGIN_DIR;

  // Ensure plugin directory exists
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Install the npm package into the plugin directory
  try {
    execSync(`npm install --prefix "${pluginDir}" "${npmPackage}"`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (err) {
    throw new PluginError(
      `npm install failed: ${err instanceof Error ? err.message : String(err)}`,
      npmPackage,
      err,
    );
  }

  // Find the installed package directory
  // npm install --prefix <dir> installs to <dir>/node_modules/<pkg-name>
  const nodeModulesDir = join(pluginDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    throw new PluginError(
      "npm install completed but node_modules not found",
      npmPackage,
    );
  }

  // Try to find the package in node_modules
  const installedDir = findInstalledPackage(nodeModulesDir, npmPackage);
  if (!installedDir) {
    throw new PluginError(
      `package "${npmPackage}" installed but not found in node_modules`,
      npmPackage,
    );
  }

  // Validate it has a plugin.json
  const manifestPath = join(installedDir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new PluginError(
      `installed package "${npmPackage}" does not have a plugin.json manifest`,
      npmPackage,
    );
  }

  let manifest: { name: string; version: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name: string; version: string };
  } catch {
    throw new PluginError(
      `invalid plugin.json in installed package "${npmPackage}"`,
      npmPackage,
    );
  }

  return {
    name: manifest.name,
    version: manifest.version,
    path: installedDir,
  };
}

/**
 * Find an installed package directory in node_modules.
 * Handles scoped packages (@scope/name) and regular packages.
 */
function findInstalledPackage(nodeModulesDir: string, npmPackage: string): string | null {
  // Try direct path first
  const directPath = join(nodeModulesDir, npmPackage);
  if (existsSync(directPath)) return directPath;

  // Try reading package.json from the installed package to get the real name
  try {
    const entries = existsSync(nodeModulesDir)
      ? require("node:fs").readdirSync(nodeModulesDir, { withFileTypes: true })
      : [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      let candidateDir: string;
      if (entry.name.startsWith("@")) {
        // Scoped package — look inside the scope directory
        const scopeDir = join(nodeModulesDir, entry.name);
        try {
          const scoped = require("node:fs").readdirSync(scopeDir, { withFileTypes: true });
          for (const s of scoped) {
            candidateDir = join(scopeDir, s.name);
            if (isPluginDir(candidateDir)) return candidateDir;
          }
        } catch { /* skip */ }
      } else {
        candidateDir = join(nodeModulesDir, entry.name);
        if (isPluginDir(candidateDir)) return candidateDir;
      }
    }
  } catch { /* non-fatal */ }

  return null;
}

function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, "plugin.json"));
}

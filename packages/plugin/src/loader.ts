// packages/plugin/src/loader.ts
import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Tool, RiskLevel } from "@helm/core";
import type { JsonlJournal } from "@helm/core";
import type {
  PluginManifest,
  LoadedPlugin,
  PluginModule,
  PluginToolImpl,
} from "./types.js";
import { PluginError } from "./types.js";
import { readManifest } from "./manifest.js";

/** Default plugin directories. */
const GLOBAL_PLUGIN_DIR = resolve(process.env.HOME ?? "/tmp", ".helm", "plugins");

function projectPluginDir(): string {
  return resolve(process.cwd(), ".helm", "plugins");
}

/** Config resolver: merges env vars + config file values. */
export interface PluginConfigSource {
  /** Read a config value by plugin name and key. Returns undefined if not set. */
  get(pluginName: string, key: string): string | undefined;
}

/** Environment-variable based config source. Looks up HELM_PLUGIN_<NAME>_<KEY>. */
export class EnvConfigSource implements PluginConfigSource {
  get(pluginName: string, key: string): string | undefined {
    const envKey = `HELM_PLUGIN_${pluginName.toUpperCase().replace(/-/g, "_")}_${key.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey];
  }
}

/** Static config source — wraps a plain object. */
export class StaticConfigSource implements PluginConfigSource {
  constructor(private readonly values: Record<string, string>) {}
  get(_pluginName: string, key: string): string | undefined {
    return this.values[key];
  }
}

/** Plugin loader options. */
export interface PluginLoaderOptions {
  /** Additional plugin directories to scan (beyond defaults). */
  pluginDirs?: string[];
  /** If true, skip scanning default directories (~/.helm/plugins/, .helm/plugins/). */
  skipDefaultDirs?: boolean;
  /** Config source for plugin config values. Defaults to EnvConfigSource. */
  configSource?: PluginConfigSource;
  /** Journal for emitting plugin events. */
  journal?: JsonlJournal;
  /** Run ID for journal events. */
  runId?: string;
}

/** Plugin load result — one per scanned directory. */
export interface PluginLoadResult {
  pluginName: string;
  status: "loaded" | "failed";
  error?: string;
}

/**
 * Scans plugin directories, reads manifests, loads plugin modules,
 * and returns tools ready for ToolRuntime registration.
 */
export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private modules: Map<string, PluginModule> = new Map();
  private configSource: PluginConfigSource;
  private journal?: JsonlJournal;
  private runId: string;
  private pluginDirs: string[];

  constructor(options: PluginLoaderOptions = {}) {
    this.configSource = options.configSource ?? new EnvConfigSource();
    this.journal = options.journal;
    this.runId = options.runId ?? "plugin";

    // Build directory list: project-level first (higher priority), then global
    this.pluginDirs = [];
    if (!options.skipDefaultDirs) {
      const projDir = projectPluginDir();
      if (existsSync(projDir)) this.pluginDirs.push(projDir);
      if (existsSync(GLOBAL_PLUGIN_DIR)) this.pluginDirs.push(GLOBAL_PLUGIN_DIR);
    }
    if (options.pluginDirs) {
      for (const d of options.pluginDirs) {
        if (existsSync(d) && !this.pluginDirs.includes(d)) {
          this.pluginDirs.push(d);
        }
      }
    }
  }

  /**
   * Scan all plugin directories, load each valid plugin.
   * Returns results per plugin so callers can report failures.
   */
  async loadAll(): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = [];

    for (const dir of this.pluginDirs) {
      const entries = this.scanDirectory(dir);
      for (const entry of entries) {
        const result = await this.loadOne(entry);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Load a single plugin from a directory path.
   * Gracefully skips on failure (returns error instead of throwing).
   */
  async loadOne(pluginDir: string): Promise<PluginLoadResult> {
    let manifest: PluginManifest;
    try {
      manifest = readManifest(pluginDir);
    } catch (err) {
      const name = pluginDir.split("/").pop() ?? pluginDir;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.emitError(name, errorMsg);
      return { pluginName: name, status: "failed", error: errorMsg };
    }

    // Skip if already loaded (first wins — project-level overrides global)
    if (this.plugins.has(manifest.name)) {
      return { pluginName: manifest.name, status: "loaded" };
    }

    try {
      const loaded = await this.initializePlugin(manifest, pluginDir);
      this.plugins.set(manifest.name, loaded);

      await this.emitLoad(manifest.name, manifest.version, loaded.tools.length);

      return { pluginName: manifest.name, status: "loaded" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.emitError(manifest.name, errorMsg);
      return { pluginName: manifest.name, status: "failed", error: errorMsg };
    }
  }

  /** Get all loaded plugins. */
  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get all tools from all loaded plugins (for ToolRuntime registration). */
  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const plugin of this.plugins.values()) {
      tools.push(...plugin.tools);
    }
    return tools;
  }

  /** Get all skills from all loaded plugins. */
  getSkills(): Array<{ pluginName: string; name: string; description?: string }> {
    const skills: Array<{ pluginName: string; name: string; description?: string }> = [];
    for (const plugin of this.plugins.values()) {
      for (const skill of plugin.skills) {
        skills.push({ pluginName: plugin.name, ...skill });
      }
    }
    return skills;
  }

  /** Get all prompts from all loaded plugins. */
  getPrompts(): Array<{ pluginName: string; name: string; description?: string; template?: string }> {
    const prompts: Array<{ pluginName: string; name: string; description?: string; template?: string }> = [];
    for (const plugin of this.plugins.values()) {
      for (const prompt of plugin.prompts) {
        prompts.push({ pluginName: plugin.name, ...prompt });
      }
    }
    return prompts;
  }

  /** Call destroy() on all loaded plugin modules. */
  async destroyAll(): Promise<void> {
    for (const [name, mod] of this.modules) {
      try {
        await mod.destroy?.();
      } catch (err) {
        // Best-effort cleanup — log but don't throw
        await this.emitError(name, `destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Number of successfully loaded plugins. */
  get count(): number {
    return this.plugins.size;
  }

  // ── Private ───────────────────────────────────────────────────────────

  /**
   * Scan a directory for plugin subdirectories.
   * Each subdirectory that contains a plugin.json is a plugin candidate.
   */
  private scanDirectory(dir: string): string[] {
    if (!existsSync(dir)) return [];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * Initialize a plugin: resolve its entry file, dynamic import, call init.
   */
  private async initializePlugin(
    manifest: PluginManifest,
    pluginDir: string,
  ): Promise<LoadedPlugin> {
    const entryFile = manifest.main ?? "index.js";
    const entryPath = resolve(pluginDir, entryFile);

    let module: PluginModule | undefined;

    if (existsSync(entryPath)) {
      try {
        const imported = await import(entryPath);
        module = imported.default ?? imported;
      } catch (err) {
        throw new PluginError(
          `failed to import entry file: ${err instanceof Error ? err.message : String(err)}`,
          manifest.name,
          err,
        );
      }
    }

    // Resolve config for this plugin
    const config = this.resolveConfig(manifest);

    // Call init hook if present
    if (module?.init) {
      try {
        await module.init(config);
      } catch (err) {
        throw new PluginError(
          `init() failed: ${err instanceof Error ? err.message : String(err)}`,
          manifest.name,
          err,
        );
      }
    }

    this.modules.set(manifest.name, module ?? {});

    // Build tools from manifest declarations + module implementations
    const tools = this.buildTools(manifest, module, pluginDir);

    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      path: pluginDir,
      manifest,
      module,
      tools,
      skills: manifest.skills ?? [],
      prompts: manifest.prompts ?? [],
    };
  }

  /**
   * Build Tool objects from manifest declarations and module implementations.
   * Manifest declares tools; module provides execute functions.
   * If module has no matching execute, falls back to a stub.
   */
  private buildTools(
    manifest: PluginManifest,
    module: PluginModule | undefined,
    pluginDir: string,
  ): Tool[] {
    const manifestTools = manifest.tools ?? [];
    const moduleTools = module?.tools ?? [];

    // Index module tools by name for lookup
    const moduleToolMap = new Map<string, PluginToolImpl>();
    for (const mt of moduleTools) {
      moduleToolMap.set(mt.name, mt);
    }

    const tools: Tool[] = [];

    for (const def of manifestTools) {
      const namespacedName = `${manifest.name}__${def.name}`;
      const impl = moduleToolMap.get(def.name);

      const execute = impl?.execute ?? (async () => {
        return `Plugin tool "${def.name}" has no implementation`;
      });

      tools.push({
        name: namespacedName,
        description: def.description ?? `[Plugin:${manifest.name}] ${def.name}`,
        parameters: def.parameters ?? { type: "object", properties: {} },
        riskLevel: def.riskLevel as RiskLevel | undefined,
        execute,
      });
    }

    // Also register module tools not declared in manifest (dynamic tools)
    for (const impl of moduleTools) {
      const alreadyRegistered = manifestTools.some((d) => d.name === impl.name);
      if (alreadyRegistered) continue;

      const namespacedName = `${manifest.name}__${impl.name}`;
      tools.push({
        name: namespacedName,
        description: impl.description ?? `[Plugin:${manifest.name}] ${impl.name}`,
        parameters: impl.parameters ?? { type: "object", properties: {} },
        riskLevel: impl.riskLevel as RiskLevel | undefined,
        execute: impl.execute,
      });
    }

    return tools;
  }

  /**
   * Resolve plugin config from manifest declarations.
   * Reads from config source, falls back to defaults.
   */
  private resolveConfig(manifest: PluginManifest): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const def of manifest.config ?? []) {
      const value = this.configSource.get(manifest.name, def.key);
      if (value !== undefined) {
        config[def.key] = value;
      } else if (def.default !== undefined) {
        config[def.key] = def.default;
      } else if (def.required) {
        throw new PluginError(
          `required config "${def.key}" not set`,
          manifest.name,
        );
      }
    }
    return config;
  }

  private async emitLoad(name: string, version: string, toolCount: number): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.append({
        type: "plugin:load",
        runId: this.runId,
        pluginName: name,
        pluginVersion: version,
        toolCount,
        timestamp: Date.now(),
      });
    } catch {
      // Best-effort
    }
  }

  private async emitError(name: string, message: string): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.append({
        type: "plugin:error",
        runId: this.runId,
        pluginName: name,
        message,
        timestamp: Date.now(),
      });
    } catch {
      // Best-effort
    }
  }
}

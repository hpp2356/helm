// packages/plugin/src/index.ts
export { PluginLoader, EnvConfigSource, StaticConfigSource } from "./loader.js";
export type { PluginLoaderOptions, PluginLoadResult, PluginConfigSource } from "./loader.js";
export { readManifest, validateManifest } from "./manifest.js";
export { installPlugin } from "./installer.js";
export {
  PluginError,
  type PluginManifest,
  type PluginToolDef,
  type PluginSkillDef,
  type PluginPromptDef,
  type PluginConfigDef,
  type LoadedPlugin,
  type PluginModule,
  type PluginToolImpl,
  type PluginSkillImpl,
  type PluginSkillContext,
} from "./types.js";

// packages/prompt/src/index.ts

export { renderTemplate, extractVariables, hashContent } from "./template-engine.js";
export { PromptLoader, type PromptLoaderOptions } from "./prompt-loader.js";
export {
  VariableRegistry,
  registerBuiltinVariables,
  parseCliVariable,
  loadVariablesFromFile,
} from "./variable-registry.js";
export { PromptBuilder, buildDefaultPrompt } from "./prompt-builder.js";
export { DEFAULT_TEMPLATE, CONCISE_TEMPLATE } from "./default-prompt.js";
export {
  VariableSource,
  type VariableEntry,
  type PromptLayers,
  type BuiltPrompt,
  type OutputStyleMeta,
  type PromptBuildOptions,
} from "./types.js";

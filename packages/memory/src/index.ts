// packages/memory/src/index.ts
export { MemoryStore } from "./store.js";
export { matchGlob, matchesGlobs, filterRulesForFile } from "./rules.js";
export { detectAutoMemoryTriggers, createAutoMemoryWrite } from "./auto-memory.js";
export type {
  MemoryScope,
  MemoryType,
  MemoryEntry,
  MemoryRule,
  MemoryLoadResult,
  MemoryStoreOptions,
  AutoMemoryTrigger,
  AutoMemoryWrite,
} from "./types.js";

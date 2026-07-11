// packages/skill/src/builtins.ts
import type { Skill } from "./types.js";
import type { SkillRegistry } from "./registry.js";
import type { StreamingBus } from "@helm/core";

/** Dependencies injected into built-in skills. */
export interface BuiltinDeps {
  /** Get all registered tool names. */
  getToolNames: () => string[];
  /** Get message history length. */
  getMessageCount: () => number;
  /** Get turn count. */
  getTurnCount: () => number;
  /** Provider name. */
  providerName: string;
  /** Journal path. */
  journalPath: string;
  /** Get loaded plugin info. */
  getPlugins: () => Array<{ name: string; version: string; toolCount: number }>;
  /** Clear message history (resets to system message). Returns new count. */
  clearMessages: () => number;
  /** Signal the REPL to close. */
  close: () => void;
  /** Skill registry (for /help to list skills). */
  registry: SkillRegistry;
  /** Get the StreamingBus (if available). */
  getStreamingBus?: () => StreamingBus | undefined;
}

/** Create built-in skills. */
export function createBuiltinSkills(deps: BuiltinDeps): Skill[] {
  return [
    createHelpSkill(deps),
    createToolsSkill(deps),
    createClearSkill(deps),
    createExitSkill(deps),
    createStatsSkill(deps),
    createPluginsSkill(deps),
  ];
}

function createHelpSkill(deps: BuiltinDeps): Skill {
  return {
    name: "help",
    description: "List all available skills",
    handler: async (_input, _ctx) => {
      const skills = deps.registry.list();
      if (skills.length === 0) {
        return "No skills registered.";
      }
      const lines = skills.map((s) => `  /${s.name}  — ${s.description}`);
      return `Skills (${skills.length}):\n${lines.join("\n")}\n\nCtrl-C interrupt  |  Ctrl-D exit  |  Ctrl-X Ctrl-E external editor`;
    },
  };
}

function createToolsSkill(deps: BuiltinDeps): Skill {
  return {
    name: "tools",
    description: "List all available tools",
    handler: async (_input, _ctx) => {
      const names = deps.getToolNames();
      if (names.length === 0) return "No tools registered.";
      return `Tools (${names.length}):\n${names.map((n) => `  • ${n}`).join("\n")}`;
    },
  };
}

function createClearSkill(deps: BuiltinDeps): Skill {
  return {
    name: "clear",
    description: "Clear conversation history",
    handler: async (_input, _ctx) => {
      const count = deps.clearMessages();
      return `Conversation history cleared. (${count} messages removed)`;
    },
  };
}

function createExitSkill(deps: BuiltinDeps): Skill {
  return {
    name: "exit",
    description: "Exit REPL",
    handler: async (_input, _ctx) => {
      deps.close();
      return "Goodbye.";
    },
  };
}

function createStatsSkill(deps: BuiltinDeps): Skill {
  return {
    name: "stats",
    description: "Show session statistics",
    handler: async (_input, _ctx) => {
      const lines = [
        "Session stats:",
        `  Messages: ${deps.getMessageCount()}`,
        `  Turns:    ${deps.getTurnCount()}`,
        `  Provider: ${deps.providerName}`,
        `  Journal:  ${deps.journalPath}`,
      ];

      const bus = deps.getStreamingBus?.();
      if (bus) {
        const s = bus.stats;
        lines.push("");
        lines.push("Streaming stats:");
        lines.push(`  Text tokens:      ${s.textTokens}`);
        lines.push(`  Tool call deltas: ${s.toolCallDeltaCount}`);
        lines.push(`  Thinking tokens:  ${s.thinkingTokens}`);
      }

      return lines.join("\n");
    },
  };
}

function createPluginsSkill(deps: BuiltinDeps): Skill {
  return {
    name: "plugins",
    description: "List loaded plugins",
    handler: async (_input, _ctx) => {
      const plugins = deps.getPlugins();
      if (plugins.length === 0) return "No plugins loaded.";
      return `Plugins (${plugins.length}):\n${plugins.map((p) => `  • ${p.name} v${p.version} (${p.toolCount} tools)`).join("\n")}`;
    },
  };
}

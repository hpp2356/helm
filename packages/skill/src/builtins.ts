// packages/skill/src/builtins.ts
import type { Skill } from "./types.js";
import type { SkillRegistry } from "./registry.js";
import type { StreamingBus } from "@helm/core";
import type { MemoryStore } from "@helm/memory";

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
  /** Get loaded hook config summary. */
  getHooks?: () => { rules: Array<{ event: string; matcher: string; command: string }>; bypassTrust: boolean; disabled: boolean };
  /** Get usage status (session and daily). */
  getUsageStatus?: () => { session: string; daily: string };
  /** Get memory store (if available). */
  getMemoryStore?: () => MemoryStore | undefined;
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
    createHooksSkill(deps),
    createUsageSkill(deps),
    createMemorySkill(deps),
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

function createHooksSkill(deps: BuiltinDeps): Skill {
  return {
    name: "hooks",
    description: "List loaded hooks",
    handler: async (_input, _ctx) => {
      const hooks = deps.getHooks?.();
      if (!hooks) return "Hooks: not available.";
      if (hooks.disabled) return "Hooks: disabled (--no-hooks).";

      const lines = [`Hooks (trust bypass: ${hooks.bypassTrust ? "yes" : "no"}):`];
      if (hooks.rules.length === 0) {
        lines.push("  No hooks configured.");
      } else {
        for (const rule of hooks.rules) {
          lines.push(`  ${rule.event}  matcher=${rule.matcher || "*"}  → ${rule.command}`);
        }
      }
      return lines.join("\n");
    },
  };
}

function createUsageSkill(deps: BuiltinDeps): Skill {
  return {
    name: "usage",
    description: "Show token usage and cost statistics",
    handler: async (_input, _ctx) => {
      const usage = deps.getUsageStatus?.();
      if (!usage) return "Usage tracking not available.";
      return `${usage.session}\n\n${usage.daily}`;
    },
  };
}

function createMemorySkill(deps: BuiltinDeps): Skill {
  return {
    name: "memory",
    description: "Manage persistent memory (list/show/search/clear/export/import)",
    handler: async (input, _ctx) => {
      const store = deps.getMemoryStore?.();
      if (!store) return "Memory not available.";

      const parts = input.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "list";
      const arg = parts.slice(1).join(" ");

      switch (sub) {
        case "list": {
          const s = store.summary();
          const lines = [
            "Memory summary:",
            `  Instructions: ${s.instructions} section(s)`,
            `  Auto memory:  ${s.auto} section(s)`,
            `  Rules:        ${s.rules} rule(s)`,
            `  Total lines:  ${s.totalLines}`,
          ];
          if (s.errors > 0) lines.push(`  Errors:       ${s.errors}`);
          return lines.join("\n");
        }

        case "show": {
          const result = store.load();
          const parts: string[] = [];

          if (result.instructions.length > 0) {
            parts.push("── Instructions ──");
            for (const entry of result.instructions) {
              const label = entry.heading ?? entry.source;
              parts.push(`  [${entry.scope}] ${label}`);
              const preview = entry.content.split("\n").slice(0, 3).join(" | ");
              parts.push(`    ${preview.length > 80 ? preview.slice(0, 79) + "…" : preview}`);
            }
          }

          if (result.auto.length > 0) {
            parts.push("");
            parts.push("── Auto Memory ──");
            for (const entry of result.auto) {
              const label = entry.heading ?? entry.source;
              parts.push(`  ${label}`);
              const preview = entry.content.split("\n").slice(0, 2).join(" | ");
              parts.push(`    ${preview.length > 80 ? preview.slice(0, 79) + "…" : preview}`);
            }
          }

          if (result.rules.length > 0) {
            parts.push("");
            parts.push("── Rules ──");
            for (const rule of result.rules) {
              parts.push(`  ${rule.description}  globs=[${rule.globs.join(", ")}]`);
            }
          }

          if (parts.length === 0) return "No memory loaded.";
          return parts.join("\n");
        }

        case "search": {
          if (!arg) return "Usage: /memory search <keyword>";
          const matches = store.search(arg);
          if (matches.length === 0) return `No matches for "${arg}".`;
          const lines = [`Found ${matches.length} match(es) for "${arg}":`];
          for (const m of matches.slice(0, 10)) {
            const source = "source" in m.entry ? m.entry.source : (m.entry as { source: string }).source;
            lines.push(`  ${source}: ${m.match}`);
          }
          if (matches.length > 10) lines.push(`  ... and ${matches.length - 10} more`);
          return lines.join("\n");
        }

        case "clear": {
          const scope = (arg || "session") as "session" | "project" | "all";
          if (!["session", "project", "all"].includes(scope)) {
            return "Usage: /memory clear [session|project|all]";
          }
          store.clear(scope);
          return `Memory cleared (scope: ${scope}).`;
        }

        case "export": {
          return store.exportAll();
        }

        case "import": {
          if (!arg) return "Usage: /memory import <content>";
          store.importAll(arg);
          return "Memory imported.";
        }

        default:
          return "Usage: /memory [list|show|search|clear|export|import] [args]";
      }
    },
  };
}

import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonlJournal,
  RiskLevel,
  TokenBudget,
  type PermissionPolicy,
  type NonInteractiveStrategy,
} from "@helm/core";
import {
  AgentLoop,
  ToolRuntime,
  PermissionRuntime,
  Compaction,
  CharTokenCounter,
  ContextBuilder,
  type CompactionStrategy,
  type MessageRecord,
} from "@helm/runtime";
import { registerFileTools } from "@helm/runtime";
import type { Provider } from "@helm/core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReplConfig {
  /** Pre-built provider instance. */
  provider: Provider;
  /** Display name for the provider. */
  providerName: string;
  /** Path to tools JSON file. */
  toolsPath?: string;
  /** Path to permissions JSON file. */
  permsPath?: string;
  /** Workspace root for file tools. */
  workspaceRoot?: string;
  /** Non-interactive permission strategy. */
  nonInteractive?: NonInteractiveStrategy;
  /** Risk threshold for risk-threshold strategy. */
  riskThreshold?: RiskLevel;
  /** Compaction strategy. */
  compaction?: CompactionStrategy;
  /** Number of recent turns to keep in compaction. */
  compactionKeepTurns: number;
  /** Token budget max for compaction trigger. */
  tokenBudgetMax?: number;
  /** Max turns per AgentLoop run. */
  maxTurns: number;
}

interface PermRule {
  action: "allow" | "deny";
  pattern: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const WELCOME = `
╭─────────────────────────────────────────────────────╮
│                   Helm REPL                          │
│  Type your message and press Enter to send.          │
│  /help    — Show available commands                  │
│  /clear   — Clear conversation history               │
│  /exit    — Exit REPL                                │
│  /stats   — Show session stats                       │
╰─────────────────────────────────────────────────────╯`;

const HELM_HISTORY_FILE = `${process.env.HOME || "~"}/.helm_history`;

// ── Helpers ────────────────────────────────────────────────────────────────

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

// ── REPL ───────────────────────────────────────────────────────────────────

export async function startRepl(config: ReplConfig): Promise<void> {
  const runId = `repl-${Date.now()}`;
  const journalPath = `/tmp/helm-${runId}.jsonl`;
  const journal = new JsonlJournal(journalPath);
  await journal.open();

  // ── Build permissions ──────────────────────────────────────────────
  const permissionRuntime = new PermissionRuntime();
  let permissionPolicy: PermissionPolicy | undefined;

  if (config.permsPath) {
    const permRules = loadJson<PermRule[]>(config.permsPath);
    for (const rule of permRules) {
      if (rule.action === "deny") {
        permissionRuntime.deny({
          pattern: rule.pattern,
          riskLevel: RiskLevel[rule.riskLevel],
          description: rule.description,
        });
      } else {
        permissionRuntime.allow({
          pattern: rule.pattern,
          riskLevel: RiskLevel[rule.riskLevel],
          description: rule.description,
        });
      }
    }
  }

  if (config.nonInteractive) {
    permissionPolicy = {
      strategy: config.nonInteractive,
      riskThreshold: config.riskThreshold,
    };
  }

  // ── Build tools ─────────────────────────────────────────────────────
  const toolRuntime = new ToolRuntime(permissionRuntime, permissionPolicy);
  const workspaceRoot = config.workspaceRoot ?? process.cwd();

  if (config.toolsPath) {
    interface ToolDef {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    }
    const toolDefs = loadJson<ToolDef[]>(config.toolsPath);
    for (const td of toolDefs) {
      toolRuntime.register({
        name: td.name,
        description: td.description,
        parameters: td.parameters,
        riskLevel: td.riskLevel ? RiskLevel[td.riskLevel] : undefined,
        async execute(args: Record<string, unknown>) {
          return JSON.stringify(
            Object.entries(args).map(([k, v]) => `${k}=${v}`),
          );
        },
      });
    }
  } else {
    // Default: built-in file tools
    registerFileTools(toolRuntime, workspaceRoot);
    for (const tool of toolRuntime.list()) {
      permissionRuntime.allow({
        pattern: tool.name,
        riskLevel: tool.riskLevel ?? RiskLevel.LOW,
        description: `Built-in tool: ${tool.name}`,
      });
    }
  }

  // ── Provider (pre-built, passed in by caller) ──────────────────────
  const provider = config.provider;

  // ── Compaction ──────────────────────────────────────────────────────
  let tokenBudget: TokenBudget | undefined;
  let compaction: Compaction | undefined;
  let contextBuilder: ContextBuilder | undefined;

  if (config.compaction) {
    const tokenCounter = new CharTokenCounter();
    contextBuilder = new ContextBuilder(tokenCounter);
    const budgetMax = config.tokenBudgetMax ?? 4096;
    tokenBudget = new TokenBudget(budgetMax);
    compaction = new Compaction({
      strategy: config.compaction,
      tokenCounter,
      keepRecentTurns: config.compactionKeepTurns,
    });
  }

  // ── Journal interceptor (compact display for REPL) ─────────────────
  const originalAppend = journal.append.bind(journal);
  journal.append = async function (event) {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "tool:call":
        console.log(`  🔧 ${e.toolName}(${JSON.stringify(e.args)})`);
        break;
      case "tool:result": {
        const out = String(e.output ?? "");
        const preview = out.length > 80 ? out.slice(0, 80) + "..." : out;
        const icon = out.startsWith("Error:") ? "⛔" : "📤";
        console.log(`  ${icon} ${preview}`);
        break;
      }
      case "compaction":
        console.log(
          `  🗜️  Compaction: msgs ${e.messageCountBefore}→${e.messageCountAfter}`,
        );
        break;
      case "error":
        console.log(`  ❌ ${e.message}`);
        break;
      case "run:cancelled":
        console.log(`  🛑 Cancelled: ${e.reason}`);
        break;
    }
    await originalAppend(event);
  };

  // ── History file ───────────────────────────────────────────────────
  const historyLines: string[] = [];
  try {
    if (existsSync(HELM_HISTORY_FILE)) {
      historyLines.push(
        ...readFileSync(HELM_HISTORY_FILE, "utf-8")
          .split("\n")
          .filter((l) => l.trim()),
      );
    }
  } catch {
    // Non-fatal
  }

  // ── Readline setup ─────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\n> ",
    terminal: true,
  });

  // ── REPL state ─────────────────────────────────────────────────────
  let messageHistory: MessageRecord[] = [];
  let turnCount = 0;

  console.log(WELCOME);
  console.log(`\nProvider: ${config.providerName}`);
  console.log(`Journal: ${journalPath}`);
  const toolNames = toolRuntime.getToolNames();
  console.log(
    `Tools: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}`,
  );
  if (config.nonInteractive) {
    console.log(`Permission: non-interactive (${config.nonInteractive})`);
  }

  rl.prompt();

  // ── Input handler ──────────────────────────────────────────────────
  const processInput = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Save to history
    if (trimmed) {
      historyLines.push(trimmed);
    }

    // ── REPL commands ────────────────────────────────────────────
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();

      switch (cmd) {
        case "/exit":
        case "/quit":
        case "/q": {
          console.log("Goodbye.");
          rl.close();
          return;
        }

        case "/clear":
          messageHistory = [];
          turnCount = 0;
          console.log("✔ Conversation history cleared.");
          rl.prompt();
          return;

        case "/help":
          console.log(`
Commands:
  /exit, /quit, /q  — Exit REPL
  /clear            — Clear conversation history
  /help             — Show this help
  /stats            — Show session stats
  /mode <strategy>  — Switch non-interactive mode (auto-approve|auto-deny|risk-threshold)

Press Enter to send. Ctrl-C to interrupt current turn.`);
          rl.prompt();
          return;

        case "/stats":
          console.log(`
Session stats:
  Messages: ${messageHistory.length}
  Turns:    ${turnCount}
  Provider: ${config.providerName}
  Journal:  ${journalPath}`);
          rl.prompt();
          return;

        case "/mode": {
          const strategy = parts[1];
          if (
            strategy === "auto-approve" ||
            strategy === "auto-deny" ||
            strategy === "risk-threshold"
          ) {
            const ni = strategy as NonInteractiveStrategy;
            config.nonInteractive = ni;
            permissionPolicy = {
              strategy: ni,
              riskThreshold: config.riskThreshold ?? RiskLevel.MEDIUM,
            };
            console.log(`✔ Permission mode: ${ni}`);
          } else {
            console.log(
              "Usage: /mode <auto-approve|auto-deny|risk-threshold>",
            );
          }
          rl.prompt();
          return;
        }

        default:
          console.log(`Unknown command: ${cmd}. Type /help for help.`);
          rl.prompt();
          return;
      }
    }

    // ── Normal message → AgentLoop ────────────────────────────────
    turnCount++;
    const turnRunId = `${runId}-t${turnCount}`;

    // Ctrl-C handler for this turn only
    const turnController = new AbortController();
    const prevSigint = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    const onTurnSigint = () => {
      console.log("\n  ⚠ Interrupting...");
      turnController.abort();
    };
    process.once("SIGINT", onTurnSigint);

    try {
      const loop = new AgentLoop(provider, toolRuntime, journal, {
        maxTurns: config.maxTurns ?? 10,
        signal: turnController.signal,
        tokenBudget,
        contextBuilder,
        compaction,
      });

      const result = await loop.run(turnRunId, trimmed, messageHistory);

      if (result.cancelled) {
        console.log(`  (Turn cancelled: ${result.cancelled.reason})`);
      }

      // Print assistant text
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage && lastMessage.role === "assistant" && lastMessage.content) {
        console.log(`\n${lastMessage.content}`);
      }

      // Update message history for next turn
      messageHistory = result.messages;
    } catch (err) {
      console.log(
        `  ❌ Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      process.removeAllListeners("SIGINT");
      for (const listener of prevSigint) {
        process.on("SIGINT", listener);
      }
    }

    rl.prompt();
  };

  // ── Readline event handlers ────────────────────────────────────────
  rl.on("line", (line) => {
    processInput(line).catch((err) => {
      console.error(`REPL error: ${err.message}`);
      rl.prompt();
    });
  });

  rl.on("close", () => {
    // Save history
    try {
      const dir = process.env.HOME ?? "/tmp";
      writeFileSync(
        `${dir}/.helm_history`,
        historyLines.slice(-500).join("\n"),
        "utf-8",
      );
    } catch {
      // Non-fatal
    }
    journal.close().catch(() => {});
    console.log(`\nJournal → ${journalPath}`);
  });

  // ── Wait for close ─────────────────────────────────────────────────
  return new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}

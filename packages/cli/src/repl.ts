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
  provider: Provider;
  providerName: string;
  toolsPath?: string;
  permsPath?: string;
  workspaceRoot?: string;
  nonInteractive?: NonInteractiveStrategy;
  riskThreshold?: RiskLevel;
  compaction?: CompactionStrategy;
  compactionKeepTurns: number;
  tokenBudgetMax?: number;
  maxTurns: number;
  systemPrompt?: string | null;
  configPath?: string;
}

interface PermRule {
  action: "allow" | "deny";
  pattern: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/** Minimal ANSI Markdown renderer for terminal display. */
function renderMd(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    // Code fences
    if (
      text.startsWith("```", i) &&
      (i === 0 || text[i - 1] === "\n")
    ) {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        const code = text.slice(i + 3, end).replace(/^\n/, "");
        out += DIM + "  │ " + code.replace(/\n/g, "\n  │ ") + RESET + "\n";
        i = end + 3;
        continue;
      }
    }

    // Inline code
    if (text[i] === "`" && text[i + 1] !== "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += DIM + text.slice(i + 1, end) + RESET;
        i = end + 1;
        continue;
      }
    }

    // Bold
    if (text.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        out += BOLD + text.slice(i + 2, end) + RESET;
        i = end + 2;
        continue;
      }
    }

    // List marker
    if (
      (text[i] === "-" || text[i] === "*") &&
      (i === 0 || text[i - 1] === "\n") &&
      text[i + 1] === " "
    ) {
      out += "  • ";
      i += 2;
      continue;
    }

    // Numbered list
    if (
      /\d/.test(text[i]) &&
      (i === 0 || text[i - 1] === "\n")
    ) {
      const rest = text.slice(i);
      const m = rest.match(/^(\d+)\.\s/);
      if (m) {
        out += `  ${m[1]}. `;
        i += m[0].length;
        continue;
      }
    }

    // Heading
    if (text.startsWith("### ")) {
      i += 4;
      const end = text.indexOf("\n", i);
      out +=
        "\n" +
        BOLD +
        (end !== -1 ? text.slice(i, end) : text.slice(i)) +
        RESET +
        "\n";
      i = end !== -1 ? end : text.length;
      continue;
    }
    if (text.startsWith("## ") && !text.startsWith("### ")) {
      i += 3;
      const end = text.indexOf("\n", i);
      out +=
        "\n" +
        BOLD +
        (end !== -1 ? text.slice(i, end) : text.slice(i)) +
        RESET +
        "\n";
      i = end !== -1 ? end : text.length;
      continue;
    }

    out += text[i];
    i++;
  }

  return out;
}

// ── Constants ──────────────────────────────────────────────────────────────

const WELCOME = `
${BOLD}Helm${RESET} — AI Assistant
Type ${DIM}/help${RESET} for commands, ${DIM}/exit${RESET} to quit.
`;

const HELM_HISTORY_FILE = `${process.env.HOME || "~"}/.helm_history`;

// ── Helpers ────────────────────────────────────────────────────────────────

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

/** Print a horizontal rule to visually separate content from prompt. */
function hr(): void {
  const cols = process.stdout.columns ?? 80;
  console.log("\n" + DIM + "─".repeat(cols) + RESET);
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
    registerFileTools(toolRuntime, workspaceRoot);
    for (const tool of toolRuntime.list()) {
      permissionRuntime.allow({
        pattern: tool.name,
        riskLevel: tool.riskLevel ?? RiskLevel.LOW,
        description: `Built-in tool: ${tool.name}`,
      });
    }
  }

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

  // ── Journal interceptor ─────────────────────────────────────────────
  const originalAppend = journal.append.bind(journal);
  journal.append = async function (event) {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "tool:call":
        console.log(DIM + `  ⚙ ${e.toolName}` + RESET);
        break;
      case "tool:result": {
        const out = String(e.output ?? "");
        const preview = out.length > 120 ? out.slice(0, 120) + "..." : out;
        const icon = out.startsWith("Error:") ? "✗" : "✓";
        console.log(DIM + `  ${icon} ${preview}` + RESET);
        break;
      }
      case "compaction":
        console.log(
          DIM +
            `  🗜  Compaction: msgs ${e.messageCountBefore}→${e.messageCountAfter}` +
            RESET,
        );
        break;
      case "error":
        console.log(`  ✗ ${e.message}`);
        break;
      case "run:cancelled":
        console.log(DIM + `  ⏹ Cancelled: ${e.reason}` + RESET);
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
    terminal: true,
  });

  // ── REPL state ─────────────────────────────────────────────────────
  const SYSTEM_MESSAGE: MessageRecord | null =
    config.systemPrompt !== undefined
      ? config.systemPrompt === null
        ? null
        : { role: "system", content: config.systemPrompt }
      : {
          role: "system",
          content: `You are Helm, an AI assistant powered by ${config.providerName}. You are helpful, concise, and honest.`,
        };

  let messageHistory: MessageRecord[] = SYSTEM_MESSAGE
    ? [SYSTEM_MESSAGE]
    : [];
  let turnCount = 0;

  // ── Startup display ─────────────────────────────────────────────────
  console.log(WELCOME);
  const toolNames = toolRuntime.getToolNames();
  console.log(
    DIM +
      `${config.providerName}` +
      (toolNames.length > 0 ? `  ·  ${toolNames.length} tools` : "") +
      (config.configPath ? `  ·  ${config.configPath}` : "") +
      RESET,
  );
  console.log(
    DIM + `Journal: ${journalPath}` + RESET,
  );

  hr();
  rl.setPrompt("> ");
  rl.prompt();

  // ── Input handler ──────────────────────────────────────────────────
  const processInput = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      hr();
      rl.prompt();
      return;
    }

    historyLines.push(trimmed);

    // ── REPL commands ────────────────────────────────────────────
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();

      switch (cmd) {
        case "/exit":
        case "/quit":
        case "/q": {
          console.log(BOLD + "Goodbye." + RESET);
          rl.close();
          return;
        }

        case "/clear":
          messageHistory = SYSTEM_MESSAGE ? [{ ...SYSTEM_MESSAGE }] : [];
          turnCount = 0;
          console.log(DIM + "Conversation history cleared." + RESET);
          hr();
          rl.prompt();
          return;

        case "/help":
          console.log(`
Commands:
  ${BOLD}/exit, /quit, /q${RESET}  — Exit REPL
  ${BOLD}/clear${RESET}            — Clear conversation history
  ${BOLD}/help${RESET}             — Show this help
  ${BOLD}/stats${RESET}            — Show session stats
  ${BOLD}/mode <strategy>${RESET}  — Switch non-interactive mode

Press Enter to send. Ctrl-C to interrupt current turn.`);
          hr();
          rl.prompt();
          return;

        case "/stats":
          console.log(`
Session stats:
  Messages: ${messageHistory.length}
  Turns:    ${turnCount}
  Provider: ${config.providerName}
  Journal:  ${journalPath}`);
          hr();
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
            console.log(DIM + `Permission mode: ${ni}` + RESET);
          } else {
            console.log(
              "Usage: /mode <auto-approve|auto-deny|risk-threshold>",
            );
          }
          hr();
          rl.prompt();
          return;
        }

        default:
          console.log(`Unknown command: ${cmd}. Type /help for help.`);
          hr();
          rl.prompt();
          return;
      }
    }

    // ── Normal message → AgentLoop ────────────────────────────────
    turnCount++;
    const turnRunId = `${runId}-t${turnCount}`;

    // Ctrl-C for this turn only
    const turnController = new AbortController();
    const prevSigint = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    process.once("SIGINT", () => {
      console.log("\n" + DIM + "Interrupted." + RESET);
      turnController.abort();
    });

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
        console.log(DIM + `(Turn cancelled: ${result.cancelled.reason})` + RESET);
      }

      // Print assistant text with markdown rendering
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage && lastMessage.role === "assistant" && lastMessage.content) {
        const isStreaming =
          (provider as unknown as Record<string, unknown>).onText !==
            undefined &&
          (provider as unknown as Record<string, unknown>).onText !== null;
        if (!isStreaming) {
          // Scripted provider — render markdown then print
          console.log("\n" + renderMd(lastMessage.content));
        } else {
          // Streamed provider — text already printed via onText, just newline
          console.log();
        }
      }

      messageHistory = result.messages;
    } catch (err) {
      console.log(
        `  ✗ Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      process.removeAllListeners("SIGINT");
      for (const listener of prevSigint) {
        process.on("SIGINT", listener);
      }
    }

    hr();
    rl.prompt();
  };

  // ── Readline event handlers ────────────────────────────────────────
  rl.on("line", (line) => {
    processInput(line).catch((err) => {
      console.error(`REPL error: ${err.message}`);
      hr();
      rl.prompt();
    });
  });

  rl.on("close", () => {
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
    console.log(DIM + `\nJournal → ${journalPath}` + RESET);
  });

  // ── Wait for close ─────────────────────────────────────────────────
  return new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}

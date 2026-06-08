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
const ITALIC = "\x1b[3m";
const PINK = "\x1b[38;5;211m"; // mascot + section headers
const ORANGE = "\x1b[38;5;215m"; // box border

/** Whimsical past-tense verbs for the post-turn timing footer (Claude-style). */
const WORK_VERBS = [
  "Cooked",
  "Baked",
  "Brewed",
  "Simmered",
  "Forged",
  "Conjured",
  "Pondered",
  "Mulled",
  "Crafted",
  "Whipped up",
];

/** Animated star glyphs for the in-progress spinner. */
const SPIN_FRAMES = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"];

/** Whimsical gerunds shown next to the spinner while a turn runs. */
const SPIN_VERBS = [
  "Razzmatazzing",
  "Conjuring",
  "Percolating",
  "Marinating",
  "Noodling",
  "Tinkering",
  "Finagling",
  "Cogitating",
  "Simmering",
  "Hustling",
];

/** Rotating tips shown under the spinner (Helm-specific, not Claude's). */
const SPIN_TIPS = [
  "Press Ctrl-C to interrupt the current turn",
  "Type /help for the full command list",
  "/clear wipes the conversation and starts fresh",
  "/mode switches the permission strategy on the fly",
  "Every turn is journaled — replay it from /tmp later",
  "/stats shows messages, turns, and the journal path",
];

/** Visible length of a string, ignoring ANSI escape codes. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Right-pad a string to a visible width (ANSI-aware). */
function padVis(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

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

const HELM_HISTORY_FILE = `${process.env.HOME || "~"}/.helm_history`;

/** CLI version, read from the package manifest (best-effort). */
function helmVersion(): string {
  // Compiled to dist/src/repl.js, so the manifest is two levels up; source
  // layout puts it one level up. Try both.
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = new URL(rel, import.meta.url);
      const v = JSON.parse(readFileSync(pkg, "utf-8")).version;
      if (v) return v;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

/** Truncate to a visible width, appending an ellipsis when shortened. */
function truncVis(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  // Walk codepoints, copying ANSI escapes verbatim, until we hit width-1.
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < width - 1) {
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + RESET + "…";
}

/** Small pixel-art mascot, rendered in pink like Claude's. */
const MASCOT = ["  ▐▛▀▜▌  ", "  ▐▌◣◢▐▌ ", "  ▝▜▄▟▘  "];

/**
 * Render a Claude-style rounded welcome box with the title embedded in the
 * top border, a two-column body (mascot + greeting | tips) split by a vertical
 * divider, and a footer line for the working directory.
 */
function renderWelcomeBox(opts: {
  title: string;
  greeting: string;
  cwd: string;
  tips: string[];
}): string {
  const width = boxOuterWidth();
  const inner = width - 2; // space between the two vertical borders

  // Left column holds the mascot + greeting; right column holds the tips.
  const leftW = 22;
  const gapW = 3; // " │ "
  const rightW = inner - leftW - gapW;

  const left: string[] = [
    "",
    ...MASCOT.map((m) => PINK + padVis(m, 9) + RESET),
    "",
    `   ${BOLD}${opts.greeting}${RESET}`,
    "",
  ];
  const right: string[] = [`${BOLD}${PINK}Session${RESET}`, ...opts.tips];

  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];

  // Top border with embedded title: ╭─ Helm vX ──────╮
  const titleSeg = `─ ${BOLD}${opts.title}${RESET}${ORANGE} `;
  const dashes = inner - visLen(titleSeg);
  lines.push(
    ORANGE + "╭" + titleSeg + "─".repeat(Math.max(0, dashes)) + "╮" + RESET,
  );

  for (let r = 0; r < rows; r++) {
    const l = padVis(truncVis(left[r] ?? "", leftW), leftW);
    const sep = DIM + "│" + RESET;
    const rt = padVis(truncVis(right[r] ?? "", rightW), rightW);
    lines.push(
      ORANGE + "│" + RESET + " " + l + " " + sep + " " + rt + ORANGE + "│" + RESET,
    );
  }

  lines.push(ORANGE + "╰" + "─".repeat(inner) + "╯" + RESET);
  lines.push("");
  lines.push(DIM + opts.cwd + RESET);

  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

/** Blank-line separator between a turn's output and the next prompt. */
function hr(): void {
  console.log();
}

/** Outer width shared by the welcome box and the input box, so edges align. */
function boxOuterWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.min(cols - 1, 78);
}

/** Inner width (between the vertical borders) of the input box. */
function boxInnerWidth(): number {
  return Math.max(8, boxOuterWidth() - 2);
}

/**
 * The readline prompt string for the input box: a top border, then the left
 * border + `›` caret on the next line. readline rewrites only this last row as
 * the user types, so the top border survives editing.
 */
function boxedPrompt(): string {
  const top = DIM + "╭" + "─".repeat(boxInnerWidth()) + "╮" + RESET;
  return top + "\n" + DIM + "│" + RESET + " " + BOLD + ORANGE + "›" + RESET + " ";
}

/** Bottom border of the input box, printed once a line is submitted. */
function closeBox(): void {
  console.log(DIM + "╰" + "─".repeat(boxInnerWidth()) + "╯" + RESET);
}

/**
 * Render an assistant reply Claude-style: a `●` bullet on the first line, the
 * Markdown-rendered body, and continuation lines indented to align under it.
 */
function renderReply(content: string): string {
  const body = renderMd(content.trim());
  const lines = body.split("\n");
  const out = lines.map((l, idx) =>
    idx === 0 ? `${BOLD}●${RESET} ${l}` : `  ${l}`,
  );
  return out.join("\n");
}

/** Dim `✻ <verb> for Ns` footer shown after each completed turn. */
function renderTimingFooter(ms: number, verb: string): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return DIM + `✻ ${verb} for ${secs}s` + RESET;
}

/**
 * A two-line in-progress indicator shown while a turn runs: an animated star
 * with a whimsical gerund, and a dim `└ Tip:` line beneath it. Clears itself
 * (erasing both lines) when the turn completes, so the reply renders in place.
 */
class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private readonly verb: string;
  private readonly tip: string;
  private drawn = false;

  constructor(verb: string, tip: string) {
    this.verb = verb;
    this.tip = tip;
  }

  start(): void {
    if (!process.stdout.isTTY) return; // no animation when piped
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPIN_FRAMES.length;
      this.redraw();
    }, 120);
    // Don't let the interval keep the event loop alive on its own.
    this.timer.unref?.();
  }

  private render(): void {
    const star = SPIN_FRAMES[this.frame]!;
    process.stdout.write(PINK + star + RESET + " " + DIM + this.verb + "…" + RESET + "\n");
    process.stdout.write(DIM + "  └ Tip: " + this.tip + RESET + "\n");
    this.drawn = true;
  }

  private redraw(): void {
    if (!this.drawn) return;
    // Move up two lines, clear from cursor down, re-render.
    process.stdout.write("\x1b[2A\x1b[0J");
    this.render();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.drawn && process.stdout.isTTY) {
      // Erase the two spinner lines so the reply takes their place.
      process.stdout.write("\x1b[2A\x1b[0J");
      this.drawn = false;
    }
  }

  /** Print a line above the spinner (e.g. tool output), then redraw it. */
  printAbove(line: string): void {
    if (this.drawn && process.stdout.isTTY) {
      process.stdout.write("\x1b[2A\x1b[0J");
      console.log(line);
      this.render();
    } else {
      console.log(line);
    }
  }
}

/** The spinner for the turn currently in flight, if any. */
let activeSpinner: Spinner | null = null;

/** Print a line, routing above the active spinner when one is running. */
function emit(line: string): void {
  if (activeSpinner) {
    activeSpinner.printAbove(line);
  } else {
    console.log(line);
  }
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
        emit(DIM + `  ⚙ ${e.toolName}` + RESET);
        break;
      case "tool:result": {
        const out = String(e.output ?? "");
        const preview = out.length > 120 ? out.slice(0, 120) + "..." : out;
        const icon = out.startsWith("Error:") ? "✗" : "✓";
        emit(DIM + `  ${icon} ${preview}` + RESET);
        break;
      }
      case "compaction":
        emit(
          DIM +
            `  🗜  Compaction: msgs ${e.messageCountBefore}→${e.messageCountAfter}` +
            RESET,
        );
        break;
      case "error":
        emit(`  ✗ ${e.message}`);
        break;
      case "run:cancelled":
        emit(DIM + `  ⏹ Cancelled: ${e.reason}` + RESET);
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
  const home = process.env.HOME ?? "";
  const tilde = (p: string): string =>
    home && p.startsWith(home) ? "~" + p.slice(home.length) : p;

  const toolNames = toolRuntime.getToolNames();
  const tips: string[] = [
    `${DIM}Provider${RESET}  ${config.providerName}`,
    `${DIM}Tools${RESET}     ${toolNames.length}`,
  ];
  if (config.configPath) {
    tips.push(`${DIM}Config${RESET}    ${tilde(config.configPath)}`);
  }
  tips.push(`${DIM}Journal${RESET}   ${tilde(journalPath)}`);
  tips.push("");
  tips.push(`${ITALIC}${DIM}/help for commands${RESET}`);

  console.log();
  console.log(
    renderWelcomeBox({
      title: `Helm v${helmVersion()}`,
      greeting: "Welcome back!",
      cwd: tilde(process.cwd()),
      tips,
    }),
  );
  console.log();

  rl.setPrompt(boxedPrompt());
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
      activeSpinner?.stop();
      console.log("\n" + DIM + "Interrupted." + RESET);
      turnController.abort();
    });

    const turnStart = Date.now();
    const spinner = new Spinner(
      SPIN_VERBS[(turnCount - 1) % SPIN_VERBS.length]!,
      SPIN_TIPS[(turnCount - 1) % SPIN_TIPS.length]!,
    );
    activeSpinner = spinner;
    spinner.start();
    try {
      const loop = new AgentLoop(provider, toolRuntime, journal, {
        maxTurns: config.maxTurns ?? 10,
        signal: turnController.signal,
        tokenBudget,
        contextBuilder,
        compaction,
      });

      const result = await loop.run(turnRunId, trimmed, messageHistory);

      spinner.stop();
      activeSpinner = null;

      if (result.cancelled) {
        console.log(DIM + `(Turn cancelled: ${result.cancelled.reason})` + RESET);
      }

      // Render the assistant reply with a ● bullet and Markdown body, then a
      // dim timing footer — Claude-style. The full reply is buffered (no raw
      // stream echo), so **bold**, lists, and code fences render properly.
      const lastMessage = result.messages[result.messages.length - 1];
      if (
        lastMessage &&
        lastMessage.role === "assistant" &&
        lastMessage.content
      ) {
        console.log("\n" + renderReply(lastMessage.content) + "\n");
        const verb = WORK_VERBS[(turnCount - 1) % WORK_VERBS.length]!;
        console.log(renderTimingFooter(Date.now() - turnStart, verb));
      }

      messageHistory = result.messages;
    } catch (err) {
      console.log(
        `  ✗ Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Idempotent: clears the animation if any path skipped the stop above.
      spinner.stop();
      activeSpinner = null;
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
    // Close the input box (bottom border) the moment a line is submitted, so
    // every downstream path renders below a complete frame.
    closeBox();
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

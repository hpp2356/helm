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

/** Current terminal width in columns, with a fallback when it's unknown. */
function termCols(): number {
  return process.stdout.columns || 80; // 0/undefined → fall back to 80
}

/**
 * Width of the welcome card. Kept a tidy, bounded box (capped at 78) rather
 * than stretching across very wide terminals — like Claude's startup card.
 */
function boxOuterWidth(): number {
  return Math.max(8, Math.min(termCols() - 1, 78));
}

/**
 * Width of the input-frame rules. These fill the terminal (minus one column to
 * avoid wrapping a full-width rule onto the next row), so the dividers span the
 * whole window like Claude's.
 */
function frameWidth(): number {
  return Math.max(8, termCols() - 1);
}

/** A full-width horizontal rule used as the top/bottom edge of the input frame. */
function frameRule(): string {
  return DIM + "─".repeat(frameWidth()) + RESET;
}

/**
 * The readline prompt: a top rule, then the `›` caret on the next line.
 * readline only repaints this last row as the user types, so the top rule
 * stays put. The matching bottom rule is kept anchored below the cursor by
 * {@link InputFrame}.
 */
function framedPrompt(): string {
  return frameRule() + "\n" + BOLD + ORANGE + "› " + RESET;
}

/**
 * Keeps a bottom rule painted one row below the readline input. readline clears
 * everything beneath the cursor on each keystroke, so we re-paint the rule
 * after each keypress using save/restore-cursor: the input row ends up bracketed
 * by two rules (top + bottom), both visible the whole time the user is typing —
 * Claude-style.
 */
class InputFrame {
  private active = false;
  private readonly onKeypress = () => {
    if (this.active) setImmediate(() => this.paintBottom());
  };

  attach(): void {
    if (process.stdin.isTTY) {
      process.stdin.on("keypress", this.onKeypress);
    }
  }

  detach(): void {
    process.stdin.off("keypress", this.onKeypress);
  }

  /** Begin framing: caller has just issued the prompt; draw the bottom rule. */
  open(): void {
    this.active = true;
    this.paintBottom();
  }

  /** Stop framing (e.g. while a turn runs / on submit) without redrawing. */
  close(): void {
    this.active = false;
  }

  /** Whether a framed prompt is currently being shown (used by resize). */
  isActive(): boolean {
    return this.active;
  }

  private paintBottom(): void {
    if (!this.active || !process.stdout.isTTY) return;
    // Save cursor (on the input row) → newline + bottom rule → restore cursor.
    process.stdout.write("\x1b7\n" + frameRule() + "\x1b8");
  }
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

  // Bottom-anchored input frame (top + bottom rules around the `›` prompt).
  const frame = new InputFrame();
  frame.attach();

  /** Issue a fresh framed prompt: top rule + caret, then anchor the bottom rule. */
  const reprompt = (): void => {
    rl.setPrompt(framedPrompt());
    rl.prompt();
    frame.open();
  };

  // ── Live resize: reflow the active input frame to the new width ──────
  // The top rule is baked into the prompt at draw-time, so a resize alone
  // won't update it. When the terminal resizes while a framed prompt is
  // showing, step up to the top-rule row, clear the 3-row frame, and redraw
  // at the new width. readline preserves the typed line (rl.line) across the
  // redraw on its own — we must NOT re-write it, or it doubles.
  const onResize = (): void => {
    if (!frame.isActive() || !process.stdout.isTTY) return;
    frame.close(); // suspend keypress repaints during the redraw
    process.stdout.write("\x1b[1A\r\x1b[0J"); // up to top rule, clear frame
    reprompt(); // redraws top rule + preserved input, re-anchors bottom rule
  };
  if (process.stdout.isTTY) process.stdout.on("resize", onResize);

  // ── REPL state ─────────────────────────────────────────────────────
  const SYSTEM_MESSAGE: MessageRecord | null =
    config.systemPrompt !== undefined
      ? config.systemPrompt === null
        ? null
        : { role: "system", content: config.systemPrompt }
      : {
          role: "system",
          content:
            `You are Helm, an AI assistant powered by ${config.providerName}. ` +
            `You are helpful, concise, and honest.\n\n` +
            // Reply formatting — steer toward natural prose, not Markdown.
            // The model only *looks* like it "outputs Markdown" because it
            // tends to generate Markdown-style text; instructing it to write
            // flowing paragraphs (positive framing, per Anthropic's guidance)
            // is more reliable than a bare "don't use Markdown".
            `<response_format>\n` +
            `Write your replies as flowing, natural paragraphs of plain prose.\n` +
            `Organize information with ordinary sentences and paragraph breaks.\n` +
            `Weave any points into the prose ("First… Second… Also…") rather than ` +
            `breaking them into bullet or numbered lists.\n` +
            `Do not use Markdown formatting: no "#" headings, no "-"/"*" bullets, ` +
            `no numbered lists, no **bold** or *italics*, no ">" quotes, no tables.\n` +
            `Only use fenced code blocks when the user explicitly asks for code or ` +
            `a command; keep ordinary explanations in prose.\n` +
            `Keep the tone clear, direct, and measured.\n` +
            `</response_format>`,
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

  reprompt();

  // ── Input handler ──────────────────────────────────────────────────
  const processInput = async (input: string) => {
    // Empty/whitespace input is filtered out by the "line" handler before we
    // get here, so `trimmed` is always non-empty.
    const trimmed = input.trim();
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
          reprompt();
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
          reprompt();
          return;

        case "/stats":
          console.log(`
Session stats:
  Messages: ${messageHistory.length}
  Turns:    ${turnCount}
  Provider: ${config.providerName}
  Journal:  ${journalPath}`);
          hr();
          reprompt();
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
          reprompt();
          return;
        }

        default:
          console.log(`Unknown command: ${cmd}. Type /help for help.`);
          hr();
          reprompt();
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
    reprompt();
  };

  // ── Readline event handlers ────────────────────────────────────────
  rl.on("line", (line) => {
    frame.close();

    // Empty or whitespace-only Enter is a no-op, like Claude: don't run a
    // turn or scroll the transcript — just redraw the same prompt in place.
    // The 3-row frame is (top rule / input / bottom rule); after Enter the
    // cursor is on the bottom rule, so move up 2 to the top rule and clear
    // down before repainting, leaving a single frame rather than stacking.
    if (!line.trim()) {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2A\x1b[0J");
        reprompt();
      } else {
        reprompt();
      }
      return;
    }

    // Real input: step past the bottom rule so the reply (and the next framed
    // prompt) render cleanly beneath the completed frame.
    if (process.stdout.isTTY) process.stdout.write("\n");
    processInput(line).catch((err) => {
      console.error(`REPL error: ${err.message}`);
      hr();
      reprompt();
    });
  });

  rl.on("close", () => {
    frame.close();
    frame.detach();
    process.stdout.off("resize", onResize);
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

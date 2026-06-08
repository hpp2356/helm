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
import {
  PasteBuffer,
  pastePlaceholder,
  expandPastes,
  BRACKETED_PASTE_ON,
  BRACKETED_PASTE_OFF,
} from "./paste.js";
import { theme } from "./theme.js";
import { InputFrame } from "./input-frame.js";
import { renderStatusBar } from "./status-bar.js";
import { sanitize, isBinary, collapseOutput } from "./sanitize.js";
import { TurnStateMachine, type TurnState } from "./state-machine.js";
import {
  renderAssistantCard,
  renderToolCard,
  renderErrorCard,
  renderSystemNotice,
  pickVerb,
} from "./transcript.js";
import { loadKeybindings } from "./keybindings.js";
import { openExternalEditor } from "./editor.js";

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

// ── Constants ──────────────────────────────────────────────────────────────

const HELM_HISTORY_FILE = `${process.env.HOME || "~"}/.helm_history`;

const SPIN_FRAMES = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"];
const SPIN_VERBS = [
  "Razzmatazzing", "Conjuring", "Percolating", "Marinating",
  "Noodling", "Tinkering", "Finagling", "Cogitating",
];
const SPIN_TIPS = [
  "Press Ctrl-C to interrupt the current turn",
  "Type /help for the full command list",
  "/clear wipes the conversation and starts fresh",
  "/mode switches the permission strategy on the fly",
  "Every turn is journaled — replay it from /tmp later",
  "/stats shows messages, turns, and the journal path",
];

// ── Helpers ────────────────────────────────────────────────────────────────

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVis(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

function truncVis(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  let out = ""; let vis = 0; let i = 0;
  while (i < s.length && vis < width - 1) {
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    out += s[i]; vis++; i++;
  }
  return out + theme.reset + "…";
}

function termCols(): number {
  return process.stdout.columns || 80;
}

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

function hr(): void { console.log(); }

function helmVersion(): string {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = new URL(rel, import.meta.url);
      const v = JSON.parse(readFileSync(pkg, "utf-8")).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  return "0.0.0";
}

// ── Welcome Box ────────────────────────────────────────────────────────────

const MASCOT = ["  ▐▛▀▜▌  ", "  ▐▌◣◢▐▌ ", "  ▝▜▄▟▘  "];

function renderWelcomeBox(opts: { title: string; greeting: string; cwd: string; tips: string[] }): string {
  const width = Math.max(8, Math.min(termCols() - 1, 78));
  const inner = width - 2;
  const leftW = 22; const gapW = 3; const rightW = inner - leftW - gapW;
  const left: string[] = ["", ...MASCOT.map((m) => theme.accent(padVis(m, 9))), "", `   ${theme.bold(opts.greeting)}`, ""];
  const right: string[] = [`${theme.bold(theme.accent("Session"))}`, ...opts.tips];
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  const titleSeg = `─ ${theme.bold(opts.title)}${theme.border(" ")}`;
  const dashes = inner - visLen(titleSeg);
  lines.push(theme.border("╭") + titleSeg + theme.border("─".repeat(Math.max(0, dashes)) + "╮"));
  for (let r = 0; r < rows; r++) {
    const l = padVis(truncVis(left[r] ?? "", leftW), leftW);
    const sep = theme.dim("│");
    const rt = padVis(truncVis(right[r] ?? "", rightW), rightW);
    lines.push(theme.border("│") + " " + l + " " + sep + " " + rt + theme.border("│"));
  }
  lines.push(theme.border("╰" + "─".repeat(inner) + "╯"));
  lines.push(""); lines.push(theme.dim(opts.cwd));
  return lines.join("\n");
}

// ── Spinner ────────────────────────────────────────────────────────────────

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private drawn = false;
  constructor(private readonly verb: string, private readonly tip: string) {}

  start(): void {
    if (!process.stdout.isTTY) return;
    this.render();
    this.timer = setInterval(() => { this.frame = (this.frame + 1) % SPIN_FRAMES.length; this.redraw(); }, 120);
    this.timer.unref?.();
  }

  private render(): void {
    process.stdout.write(theme.accent(SPIN_FRAMES[this.frame]!) + " " + theme.dim(this.verb + "…") + "\n");
    process.stdout.write(theme.dim("  └ Tip: " + this.tip) + "\n");
    this.drawn = true;
  }

  private redraw(): void {
    if (!this.drawn) return;
    process.stdout.write("\x1b[2A\x1b[0J");
    this.render();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[2A\x1b[0J"); this.drawn = false; }
  }

  printAbove(line: string): void {
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[2A\x1b[0J"); console.log(line); this.render(); }
    else console.log(line);
  }
}

let activeSpinner: Spinner | null = null;

function emit(line: string): void {
  if (activeSpinner) activeSpinner.printAbove(line);
  else console.log(line);
}

// ── Status Bar ─────────────────────────────────────────────────────────────

interface StatusState {
  model: string;
  mode: string;
  contextPct: number;
  cost: number | null;
  durationMs: number;
  currentTool: string | null;
  bgTasks: number;
  turnStart: number;
}

let statusState: StatusState = {
  model: "", mode: "interactive", contextPct: 0,
  cost: null, durationMs: 0, currentTool: null, bgTasks: 0, turnStart: 0,
};
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusPaused = false;

function paintStatusBar(): void {
  if (statusPaused || !process.stdout.isTTY) return;
  // During a turn the spinner owns the scrollback; the cursor is NOT at the
  // composer bottom rule, so \x1b[2A would land on the wrong row.  Only paint
  // when we are at the prompt (spinner not running).
  if (activeSpinner !== null) return;
  const cols = termCols();
  const bar = renderStatusBar({ theme, cols, ...statusState });
  // Status bar sits above Composer top rule: save → up 2 → col 0 → clear line → draw → restore
  process.stdout.write("\x1b7\x1b[2A\r\x1b[2K" + bar + "\x1b8");
}

function startStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    if (statusState.turnStart > 0) statusState.durationMs = Date.now() - statusState.turnStart;
    // paintStatusBar already guards against activeSpinner !== null
    paintStatusBar();
  }, 1000);
  statusTimer.unref?.();
}

function stopStatusTimer(): void {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ── REPL ───────────────────────────────────────────────────────────────────

export async function startRepl(config: ReplConfig): Promise<void> {
  const runId = `repl-${Date.now()}`;
  const journalPath = `/tmp/helm-${runId}.jsonl`;
  const journal = new JsonlJournal(journalPath);
  await journal.open();

  loadKeybindings(); // load user keybindings (currently unused in keypress handler below, but warms the registry)
  const sm = new TurnStateMachine();

  // ── Permissions ──────────────────────────────────────────────────────
  const permissionRuntime = new PermissionRuntime();
  let permissionPolicy: PermissionPolicy | undefined;
  if (config.permsPath) {
    const permRules = loadJson<PermRule[]>(config.permsPath);
    for (const rule of permRules) {
      if (rule.action === "deny") {
        permissionRuntime.deny({ pattern: rule.pattern, riskLevel: RiskLevel[rule.riskLevel], description: rule.description });
      } else {
        permissionRuntime.allow({ pattern: rule.pattern, riskLevel: RiskLevel[rule.riskLevel], description: rule.description });
      }
    }
  }
  if (config.nonInteractive) {
    permissionPolicy = { strategy: config.nonInteractive, riskThreshold: config.riskThreshold };
  }

  // ── Tools ─────────────────────────────────────────────────────────────
  const toolRuntime = new ToolRuntime(permissionRuntime, permissionPolicy);
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  if (config.toolsPath) {
    interface ToolDef { name: string; description: string; parameters: Record<string, unknown>; riskLevel?: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"; }
    const toolDefs = loadJson<ToolDef[]>(config.toolsPath);
    for (const td of toolDefs) {
      toolRuntime.register({
        name: td.name, description: td.description, parameters: td.parameters,
        riskLevel: td.riskLevel ? RiskLevel[td.riskLevel] : undefined,
        async execute(args) { return JSON.stringify(Object.entries(args).map(([k, v]) => `${k}=${v}`)); },
      });
    }
  } else {
    registerFileTools(toolRuntime, workspaceRoot);
    for (const tool of toolRuntime.list()) {
      permissionRuntime.allow({ pattern: tool.name, riskLevel: tool.riskLevel ?? RiskLevel.LOW, description: `Built-in tool: ${tool.name}` });
    }
  }

  // ── Compaction ────────────────────────────────────────────────────────
  let tokenBudget: TokenBudget | undefined;
  let compaction: Compaction | undefined;
  let contextBuilder: ContextBuilder | undefined;
  if (config.compaction) {
    const tokenCounter = new CharTokenCounter();
    contextBuilder = new ContextBuilder(tokenCounter);
    tokenBudget = new TokenBudget(config.tokenBudgetMax ?? 4096);
    compaction = new Compaction({ strategy: config.compaction, tokenCounter, keepRecentTurns: config.compactionKeepTurns });
  }

  // ── Status bar initial state ──────────────────────────────────────────
  statusState.model = config.providerName;
  statusState.mode = config.nonInteractive ?? "interactive";

  // ── Journal interceptor ───────────────────────────────────────────────
  const originalAppend = journal.append.bind(journal);
  journal.append = async function(event) {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "tool:call": {
        const toolName = String(e.toolName ?? "");
        statusState.currentTool = toolName;
        paintStatusBar();
        emit(renderToolCard({ name: toolName, success: true, durationMs: 0 }, theme));
        break;
      }
      case "tool:result": {
        const raw = String(e.output ?? "");
        const out = isBinary(Buffer.from(raw))
          ? "[Binary output]"
          : sanitize(collapseOutput(raw).text);
        const success = !raw.startsWith("Error:");
        emit(renderToolCard({ name: String(e.toolName ?? ""), success, durationMs: 0, summary: out.slice(0, 80) }, theme));
        statusState.currentTool = null;
        paintStatusBar();
        break;
      }
      case "compaction":
        emit(renderSystemNotice(`Compaction: msgs ${e.messageCountBefore}→${e.messageCountAfter}`, theme));
        break;
      case "error":
        emit(renderErrorCard(String(e.message), theme));
        break;
      case "run:cancelled":
        emit(theme.dim(`⏹ Cancelled: ${e.reason}`));
        break;
    }
    await originalAppend(event);
  };

  // ── History ───────────────────────────────────────────────────────────
  const historyLines: string[] = [];
  try {
    if (existsSync(HELM_HISTORY_FILE)) {
      historyLines.push(...readFileSync(HELM_HISTORY_FILE, "utf-8").split("\n").filter((l) => l.trim()));
    }
  } catch { /* non-fatal */ }

  // ── Readline + frame ──────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const frame = new InputFrame(theme);
  frame.attach();
  rl.setPrompt(theme.bold(theme.accent("› ")));

  const reprompt = (): void => {
    frame.open(() => rl.prompt());
    startStatusTimer();
    paintStatusBar();
  };

  // ── Ctrl+X Ctrl+E chord state ─────────────────────────────────────────
  let ctrlXPending = false;

  // ── Bracketed paste ───────────────────────────────────────────────────
  const paste = new PasteBuffer();
  const pastedBlocks = new Map<string, string>();
  const isTTY = process.stdout.isTTY === true;
  if (isTTY) process.stdout.write(BRACKETED_PASTE_ON);

  process.stdin.on("keypress", (_chunk, key?: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (!key) return;

    if (key.name === "paste-start") { paste.start(); return; }
    if (key.name === "paste-end") {
      const { block, echoedRows } = paste.end(rl.line);
      if (echoedRows === 0) return;
      const placeholder = pastePlaceholder(block);
      pastedBlocks.set(placeholder, block);
      if (isTTY && echoedRows > 0) process.stdout.write(`\r\x1b[${echoedRows}A\x1b[0J`);
      const rlI = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
      rlI.line = placeholder; rlI.cursor = placeholder.length; rlI._refreshLine();
      frame.repaint();
      return;
    }

    // Ctrl+X Ctrl+E chord
    if (key.ctrl && key.name === "x") { ctrlXPending = true; return; }
    if (ctrlXPending) {
      ctrlXPending = false;
      if (key.ctrl && key.name === "e") {
        const rlI = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        openExternalEditor({
          rl: rlI as any,
          frame,
          onStatusPause: () => { statusPaused = true; stopStatusTimer(); },
          onStatusResume: () => { statusPaused = false; startStatusTimer(); paintStatusBar(); },
        });
        return;
      }
    }

    // Tab completion for slash commands
    if (key.name === "tab") {
      const rlI = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
      if (rlI.line.startsWith("/")) {
        const matches = COMMANDS.filter((c) => c.startsWith(rlI.line));
        if (matches.length === 1) {
          rlI.line = matches[0]!; rlI.cursor = matches[0]!.length; rlI._refreshLine();
        } else if (matches.length > 1) {
          emit(theme.dim(matches.join("  ")));
        }
      }
    }
  });

  // ── REPL state ────────────────────────────────────────────────────────
  const SYSTEM_MESSAGE: MessageRecord | null =
    config.systemPrompt !== undefined
      ? config.systemPrompt === null ? null : { role: "system", content: config.systemPrompt }
      : { role: "system", content:
          `You are Helm, an AI assistant powered by ${config.providerName}. ` +
          `You are helpful, concise, and honest.\n\n` +
          `<response_format>\nWrite replies as flowing, natural paragraphs of plain prose.\n` +
          `Do not use Markdown: no headings, no bullets, no **bold**, no tables.\n` +
          `Only use fenced code blocks when the user asks for code.\n` +
          `</response_format>`,
        };

  let messageHistory: MessageRecord[] = SYSTEM_MESSAGE ? [SYSTEM_MESSAGE] : [];
  let turnCount = 0;

  // ── Welcome box ───────────────────────────────────────────────────────
  const home = process.env.HOME ?? "";
  const tilde = (p: string): string => home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  const toolNames = toolRuntime.getToolNames();
  const tips: string[] = [
    `${theme.dim("Provider")}  ${config.providerName}`,
    `${theme.dim("Tools")}     ${toolNames.length}`,
  ];
  if (config.configPath) tips.push(`${theme.dim("Config")}    ${tilde(config.configPath)}`);
  tips.push(`${theme.dim("Journal")}   ${tilde(journalPath)}`);
  tips.push("");
  tips.push(theme.italic(theme.dim("/help for commands")));
  console.log();
  console.log(renderWelcomeBox({ title: `Helm v${helmVersion()}`, greeting: "Welcome back!", cwd: tilde(process.cwd()), tips }));
  console.log();
  reprompt();

  // ── Slash command registry ────────────────────────────────────────────
  const COMMANDS = ["/exit", "/quit", "/q", "/clear", "/help", "/stats", "/mode", "/theme", "/compact", "/tools"];

  const processInput = async (input: string): Promise<void> => {
    const trimmed = input.trim();
    historyLines.push(trimmed);

    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      switch (cmd) {
        case "/exit": case "/quit": case "/q":
          console.log(theme.bold("Goodbye.")); rl.close(); return;

        case "/clear":
          messageHistory = SYSTEM_MESSAGE ? [{ ...SYSTEM_MESSAGE }] : [];
          turnCount = 0;
          console.log(theme.dim("Conversation history cleared."));
          hr(); reprompt(); return;

        case "/help":
          console.log(`\n${theme.bold("Commands:")}\n` +
            `  ${theme.bold("/exit, /quit, /q")}  — 退出\n` +
            `  ${theme.bold("/clear")}            — 清空对话历史\n` +
            `  ${theme.bold("/stats")}            — Session 统计\n` +
            `  ${theme.bold("/mode <strategy>")} — 切换权限策略 (auto-approve|auto-deny|risk-threshold)\n` +
            `  ${theme.bold("/theme dark")}       — 切换主题\n` +
            `  ${theme.bold("/compact")}          — 手动触发 compaction\n` +
            `  ${theme.bold("/tools")}            — 列出已注册工具\n` +
            `  ${theme.bold("/help")}             — 显示此帮助\n\n` +
            `  Ctrl-C 中断 turn  │  Ctrl-D 退出  │  Ctrl-X Ctrl-E 外部编辑器`);
          hr(); reprompt(); return;

        case "/stats":
          console.log(`\n${theme.bold("Session stats:")}\n` +
            `  Messages: ${messageHistory.length}\n  Turns:    ${turnCount}\n` +
            `  Provider: ${config.providerName}\n  Journal:  ${journalPath}`);
          hr(); reprompt(); return;

        case "/tools": {
          const names = toolRuntime.getToolNames();
          console.log(`\n${theme.bold("Tools:")} ${names.length}\n` + names.map((n) => `  • ${n}`).join("\n"));
          hr(); reprompt(); return;
        }

        case "/theme":
          console.log(theme.dim("Theme: dark (only option in this version)"));
          hr(); reprompt(); return;

        case "/compact":
          if (!compaction) { console.log(theme.dim("Compaction not configured.")); hr(); reprompt(); return; }
          emit(renderSystemNotice("Manual compaction triggered", theme));
          hr(); reprompt(); return;

        case "/mode": {
          const strategy = parts[1] as NonInteractiveStrategy | undefined;
          if (strategy === "auto-approve" || strategy === "auto-deny" || strategy === "risk-threshold") {
            config.nonInteractive = strategy;
            permissionPolicy = { strategy, riskThreshold: config.riskThreshold ?? RiskLevel.MEDIUM };
            statusState.mode = strategy;
            paintStatusBar();
            console.log(theme.dim(`Permission mode: ${strategy}`));
          } else {
            console.log("Usage: /mode <auto-approve|auto-deny|risk-threshold>");
          }
          hr(); reprompt(); return;
        }

        default:
          console.log(`Unknown command: ${cmd}. Type /help for help.`);
          hr(); reprompt(); return;
      }
    }

    // ── Agent turn ─────────────────────────────────────────────────────
    if (sm.state !== "idle") {
      sm.enqueue(trimmed);
      emit(theme.dim("⏳ Queued — waiting for current turn to finish"));
      return;
    }

    turnCount++;
    sm.send("sending");

    const turnController = new AbortController();
    const prevSigint = process.listeners("SIGINT") as ((...args: unknown[]) => void)[];
    process.removeAllListeners("SIGINT");
    process.once("SIGINT", () => {
      activeSpinner?.stop();
      console.log("\n" + theme.dim("Interrupted."));
      sm.send("cancelling");
      turnController.abort();
    });

    statusState.turnStart = Date.now();
    statusState.durationMs = 0;
    paintStatusBar();

    const verb = SPIN_VERBS[(turnCount - 1) % SPIN_VERBS.length]!;
    const tip = SPIN_TIPS[(turnCount - 1) % SPIN_TIPS.length]!;
    const spinner = new Spinner(verb, tip);
    activeSpinner = spinner;
    spinner.start();

    try {
      sm.send("running");
      const loop = new AgentLoop(config.provider, toolRuntime, journal, {
        maxTurns: config.maxTurns ?? 10,
        signal: turnController.signal,
        tokenBudget, contextBuilder, compaction,
      });

      const result = await loop.run(`${runId}-t${turnCount}`, trimmed, messageHistory);
      spinner.stop(); activeSpinner = null;
      const stateAfterRun = sm.state as TurnState;
      if (stateAfterRun === "running") sm.send("completed");

      if (result.cancelled) {
        emit(theme.dim(`(Turn cancelled: ${result.cancelled.reason})`));
      }

      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.role === "assistant" && lastMessage.content) {
        const durationMs = Date.now() - statusState.turnStart;
        console.log("\n" + renderAssistantCard(lastMessage.content, durationMs, pickVerb(turnCount - 1), theme) + "\n");
      }

      messageHistory = result.messages;
      statusState.durationMs = Date.now() - statusState.turnStart;
      statusState.currentTool = null;
      statusState.turnStart = 0;
    } catch (err) {
      spinner.stop(); activeSpinner = null;
      const stateOnError = sm.state as TurnState;
      if (stateOnError === "running" || stateOnError === "sending") sm.send("failed");
      emit(renderErrorCard(err instanceof Error ? err.message : String(err), theme));
    } finally {
      if (sm.state !== "idle") sm.send("idle");
      process.removeAllListeners("SIGINT");
      for (const listener of prevSigint) process.on("SIGINT", listener);
    }

    hr();

    const queued = sm.dequeue();
    if (queued) {
      reprompt();
      await processInput(queued);
    } else {
      reprompt();
    }
  };

  // ── Readline events ───────────────────────────────────────────────────
  rl.on("line", (line) => {
    if (paste.pasting) { paste.pushInner(line); return; }
    frame.close();

    const expanded = pastedBlocks.size > 0 ? expandPastes(line, pastedBlocks) : line;
    pastedBlocks.clear();

    if (!expanded.trim()) {
      if (process.stdout.isTTY) process.stdout.write("\x1b[2A\x1b[0J");
      reprompt(); return;
    }

    if (process.stdout.isTTY) process.stdout.write("\n");
    processInput(expanded).catch((err) => {
      console.error(`REPL error: ${(err as Error).message}`);
      hr(); reprompt();
    });
  });

  rl.on("close", () => {
    frame.detach();
    stopStatusTimer();
    if (isTTY) process.stdout.write(BRACKETED_PASTE_OFF);
    try {
      writeFileSync(`${process.env.HOME ?? "/tmp"}/.helm_history`, historyLines.slice(-500).join("\n"), "utf-8");
    } catch { /* non-fatal */ }
    journal.close().catch(() => {});
    console.log(theme.dim(`\nJournal → ${journalPath}`));
  });

  return new Promise<void>((resolve) => { rl.on("close", resolve); });
}

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
import { McpRegistry } from "@helm/mcp";
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

export interface McpServerFlag {
  name: string;
  command: string;
}

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
  mcpServers?: McpServerFlag[];
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

const MASCOT = [
  "     ╱▛▀▀▀▀▀▜╲  ",
  "   ══▟ ◉ ▼ ◉ ▙══",
  "     ╲▙▁▁▁▁▁▟╱  ",
];

const NARROW_BOX = 52;

function renderWelcomeBox(opts: { title: string; greeting: string; cwd: string; tips: string[] }): string {
  const width = Math.max(8, termCols() - 1); // fill terminal width — no 78-char cap
  const inner = width - 2;
  const titleSeg = `─ ${theme.bold(opts.title)}${theme.border(" ")}`;
  const dashes = Math.max(0, inner - visLen(titleSeg));
  const lines: string[] = [];
  lines.push(theme.border("╭") + titleSeg + theme.border("─".repeat(dashes) + "╮"));

  const bRow = (content: string) => theme.border("│") + content + theme.border("│");

  if (width >= NARROW_BOX) {
    // Two-column layout.
    // Row = "│" + " " + l(leftW) + " " + "│" + " " + rt(rightW) + "│"
    //     = 1+1+leftW+1+1+1+rightW+1 = leftW+rightW+6 = width  →  rightW = width-leftW-6
    const leftW = 22;
    const rightW = Math.max(1, width - leftW - 6);
    const left: string[] = ["", ...MASCOT.map((m) => theme.accent(padVis(m, 16))), "", `   ${theme.bold(opts.greeting)}`, ""];
    const right: string[] = [`${theme.bold(theme.accent("Session"))}`, ...opts.tips];
    const rows = Math.max(left.length, right.length);
    for (let r = 0; r < rows; r++) {
      const l = padVis(truncVis(left[r] ?? "", leftW), leftW);
      const sep = theme.dim("│");
      const rt = padVis(truncVis(right[r] ?? "", rightW), rightW);
      lines.push(bRow(" " + l + " " + sep + " " + rt));
    }
  } else {
    // Single-column layout for narrow terminals.
    const center = (s: string) => {
      const vis = visLen(s);
      const lp = Math.max(0, Math.floor((inner - vis) / 2));
      return " ".repeat(lp) + s + " ".repeat(Math.max(0, inner - vis - lp));
    };
    const leftAlign = (s: string) => {
      const t = truncVis(s, inner - 2);
      return " " + t + " ".repeat(Math.max(0, inner - 1 - visLen(t)));
    };
    lines.push(bRow(" ".repeat(inner)));
    for (const m of MASCOT) lines.push(bRow(center(theme.accent(m.trim()))));
    lines.push(bRow(" ".repeat(inner)));
    lines.push(bRow(center(theme.bold(opts.greeting))));
    lines.push(bRow(" ".repeat(inner)));
    for (const tip of opts.tips) {
      lines.push(bRow(tip ? leftAlign(tip) : " ".repeat(inner)));
    }
    lines.push(bRow(" ".repeat(inner)));
  }

  lines.push(theme.border("╰" + "─".repeat(inner) + "╯"));
  lines.push("");
  lines.push(theme.dim(truncVis(opts.cwd, width - 1)));
  return lines.join("\n");
}

// ── Spinner ────────────────────────────────────────────────────────────────

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private drawn = false;
  private startMs = 0;
  constructor(private readonly verb: string) {}

  start(): void {
    if (!process.stdout.isTTY) return;
    this.startMs = Date.now();
    this.render();
    this.timer = setInterval(() => { this.frame = (this.frame + 1) % SPIN_FRAMES.length; this.redraw(); }, 120);
    this.timer.unref?.();
  }

  private elapsed(): string {
    const s = Math.floor((Date.now() - this.startMs) / 1000);
    return s > 0 ? `${s}s` : "";
  }

  private render(): void {
    const elapsed = this.elapsed();
    const suffix = elapsed ? theme.dim(` (${elapsed})`) : "";
    process.stdout.write(theme.accent("· " + this.verb + "…") + suffix + "\n");
    this.drawn = true;
  }

  private redraw(): void {
    if (!this.drawn) return;
    process.stdout.write("\x1b[1A\x1b[0J");
    this.render();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[1A\x1b[0J"); this.drawn = false; }
  }

  printAbove(line: string): void {
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[1A\x1b[0J"); console.log(line); this.render(); }
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

function printStatusBar(): void {
  if (statusPaused || !process.stdout.isTTY) return;
  const cols = termCols();
  const bar = renderStatusBar({ theme, cols, ...statusState });
  // Print the status bar as a regular scrollback line immediately before the
  // Composer frame. In-place overwriting via cursor repositioning is unreliable
  // in a scrolling REPL because the cursor is never at a known absolute row.
  process.stdout.write(bar + "\n");
}

// paintStatusBar is a no-op alias kept so journal-interceptor call sites compile
// without changes; reprompt() is the only place that actually prints the bar.
function paintStatusBar(): void { /* intentionally empty — bar is printed in reprompt() */ }

function startStatusTimer(): void {
  // No-op: in scrolling-REPL mode the status bar is re-printed on each reprompt,
  // so a 1-second timer that tries to overwrite it would corrupt the scrollback.
  // Keep the function so call sites don't break.
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

  // ── MCP Servers ───────────────────────────────────────────────────────
  const mcpRegistry = new McpRegistry();
  if (config.mcpServers && config.mcpServers.length > 0) {
    const results = await mcpRegistry.connect(
      config.mcpServers.map((s) => ({ name: s.name, command: s.command })),
    );
    for (const r of results) {
      if (r.status === "failed") {
        emit(renderSystemNotice(`MCP server "${r.serverName}" failed: ${r.error}`, theme));
      } else {
        emit(renderSystemNotice(`MCP server "${r.serverName}" connected`, theme));
      }
    }
    // Register MCP tools into ToolRuntime.
    for (const tool of mcpRegistry.tools()) {
      toolRuntime.register(tool);
      permissionRuntime.allow({
        pattern: tool.name,
        riskLevel: tool.riskLevel ?? RiskLevel.MEDIUM,
        description: `MCP tool: ${tool.name}`,
      });
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
  // Buffer pending call info so we can pair each call with its result and
  // print a single completed line instead of two separate call/result lines.
  const pendingCalls = new Map<string, { name: string; args: Record<string, unknown>; startMs: number }>();

  const originalAppend = journal.append.bind(journal);
  journal.append = async function(event) {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "assistant:text": {
        // Model reasoning text before tool calls — bright bullet, full text color.
        const text = String(e.content ?? "").trim();
        if (text) emit(theme.bold("● ") + text);
        break;
      }
      case "tool:call": {
        const toolName = String(e.toolName ?? "");
        // Use runId+toolName as key; if multiple concurrent calls use same tool
        // the last call wins (acceptable approximation for sequential tools).
        const callKey = `${String(e.runId ?? "")}_${toolName}`;
        pendingCalls.set(callKey, {
          name: toolName,
          args: (e.args as Record<string, unknown>) ?? {},
          startMs: Date.now(),
        });
        statusState.currentTool = toolName;
        paintStatusBar();
        break;
      }
      case "tool:result": {
        const toolName = String(e.toolName ?? "");
        const callKey = `${String(e.runId ?? "")}_${toolName}`;
        const pending = pendingCalls.get(callKey);
        pendingCalls.delete(callKey);

        const raw = String(e.output ?? "");
        const success = !raw.startsWith("Error:");
        const collapsed = isBinary(Buffer.from(raw)) ? "[Binary output]" : collapseOutput(raw).text;
        const cleaned = sanitize(collapsed);

        // Try to extract a human-readable summary from the JSON output.
        // Tool results are usually JSON objects; pick the most meaningful field.
        let summary: string;
        try {
          const parsed = JSON.parse(cleaned) as Record<string, unknown>;
          if (typeof parsed.replaced === "boolean") {
            // edit result: show path
            summary = String(parsed.path ?? "");
          } else if (typeof parsed.bytesWritten === "number") {
            // write result: show path + bytes
            summary = `${parsed.path ?? ""} (${parsed.bytesWritten} bytes)`;
          } else if (typeof parsed.content === "string") {
            // read result: show first line of file content
            const firstContent = parsed.content.split("\n")[0]?.trim() ?? "";
            summary = firstContent.length > 80 ? firstContent.slice(0, 79) + "…" : firstContent;
          } else if (Array.isArray(parsed.entries)) {
            // ls result: show count
            summary = `${(parsed.entries as unknown[]).length} entries`;
          } else if (Array.isArray(parsed.matches)) {
            // glob result: show count
            summary = `${(parsed.matches as unknown[]).length} matches`;
          } else {
            const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
            summary = firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine;
          }
        } catch {
          // Not JSON — show first line as-is
          const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
          summary = firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine;
        }

        const durationMs = pending ? Date.now() - pending.startMs : 0;
        emit(renderToolCard({
          name: toolName,
          args: pending?.args,
          success,
          durationMs,
          summary: summary || undefined,
        }, theme));
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
    printStatusBar();
    frame.open(() => rl.prompt());
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
      // Single-line paste (no inner newlines): leave readline buffer untouched.
      if (echoedRows === 0) return;
      const placeholder = pastePlaceholder(block);
      pastedBlocks.set(placeholder, block);
      const rlI = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
      rlI.line = placeholder; rlI.cursor = placeholder.length;
      if (isTTY) {
        // Layout when paste ends (cursor on tail row):
        //   [status bar]          ← row -(echoedRows+3) from cursor
        //   [top rule]            ← row -(echoedRows+2)
        //   [prompt + line1]      ← row -(echoedRows+1)
        //   line2 .. lineN        ← echoedRows-1 rows
        //   [tail]                ← cursor here (row 0)
        //
        // Move up (echoedRows+2) to land on the top rule row, then
        // erase to end-of-screen. The status bar row above is left intact so
        // we don't accidentally eat into transcript or welcome-box content.
        // Then redraw only the frame (top rule + prompt + bottom rule) without
        // re-printing the status bar a second time.
        frame.close();
        process.stdout.write(`\r\x1b[${echoedRows + 2}A\x1b[0J`);
        frame.open(() => rl.prompt());
        rlI.line = placeholder; rlI.cursor = placeholder.length;
        rlI._refreshLine();
        frame.repaint();
      } else {
        rlI._refreshLine();
      }
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

  const welcomeBoxOpts = { title: `Helm v${helmVersion()}`, greeting: "Welcome back!", cwd: tilde(process.cwd()), tips };

  // Track how many lines the welcome block occupies so we can erase and
  // redraw it when the terminal is resized before the first user turn.
  let welcomeLineCount = 0;
  let welcomeActive = true; // cleared on first submitted input

  function printWelcome(): void {
    const box = renderWelcomeBox(welcomeBoxOpts);
    const lines = box.split("\n");
    welcomeLineCount = lines.length + 2; // +1 leading blank line, +1 trailing blank line
    process.stdout.write("\n" + box + "\n\n");
  }

  function redrawWelcome(): void {
    if (!welcomeActive || !process.stdout.isTTY) return;
    // Erase the welcome block + status bar + frame (frame=2 rules + 1 prompt row)
    // by moving the cursor up welcomeLineCount+3 rows then clearing to end.
    frame.close();
    const eraseRows = welcomeLineCount + 3; // +status bar +top rule +prompt row
    process.stdout.write(`\r\x1b[${eraseRows}A\x1b[0J`);
    printWelcome();
    reprompt();
  }

  printWelcome();
  reprompt();

  // Listen for resize while the welcome box is still on-screen.
  process.stdout.on("resize", redrawWelcome);

  // ── Slash command registry ────────────────────────────────────────────
  const COMMANDS = ["/exit", "/quit", "/q", "/clear", "/help", "/stats", "/mode", "/theme", "/compact", "/tools"];

  let replClosing = false; // set on /exit to prevent reprompt after rl.close()

  const processInput = async (input: string): Promise<void> => {
    if (replClosing) return;
    const trimmed = input.trim();
    historyLines.push(trimmed);
    if (welcomeActive) {
      welcomeActive = false;
      process.stdout.removeListener("resize", redrawWelcome);
    }

    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      switch (cmd) {
        case "/exit": case "/quit": case "/q":
          replClosing = true;
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
    const spinner = new Spinner(verb);
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

    if (replClosing) return;

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
    if (replClosing) return;
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
      if (!replClosing) { hr(); reprompt(); }
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

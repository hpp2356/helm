import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonlJournal,
  RiskLevel,
  TokenBudget,
  type PermissionPolicy,
  type NonInteractiveStrategy,
  StreamingBus,
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
import { PluginLoader } from "@helm/plugin";
import { SkillRegistry, createBuiltinSkills, loadUserSkills, parseSkillInput } from "@helm/skill";
import { PromptBuilder } from "@helm/prompt";
import { HookRuntime } from "@helm/hooks";
import type { HookEvent } from "@helm/hooks";
import { TelemetryManager, loadTelemetryConfig } from "@helm/telemetry";
import { UsageTracker } from "@helm/usage";
import { MemoryStore } from "@helm/memory";
import { CheckpointManager } from "@helm/checkpoint";
import type { Provider, Tool, Message } from "@helm/core";
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
  args?: string[];
  env?: Record<string, string>;
  riskLevel?: string;
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
  /** Path to a custom prompt template file. */
  promptFile?: string;
  /** Variables to inject into prompt templates (--prompt-var). */
  promptVars?: Record<string, string>;
  /** Output style name (--output-style). */
  outputStyle?: string;
  /** Text to append to the default prompt (--append-prompt). */
  appendPrompt?: string;
  /** Disable all hooks (--no-hooks). */
  noHooks?: boolean;
  /** Disable specific hook events (--disable-hook=pre:tool). */
  disableHook?: string[];
  /** Bypass hook trust checks (--dangerously-bypass-hook-trust). */
  bypassHookTrust?: boolean;
  /** Disable telemetry (--no-telemetry). */
  noTelemetry?: boolean;
  /** Verbose telemetry logging (--telemetry-verbose). */
  telemetryVerbose?: boolean;
  /** Session budget limit in USD (--budget-session). */
  budgetSession?: number;
  /** Daily budget limit in USD (--budget-daily). */
  budgetDaily?: number;
  /** Monthly budget limit in USD (--budget-monthly). */
  budgetMonthly?: number;
  /** Budget warning threshold 0-1 (--budget-warning). */
  budgetWarning?: number;
  /** Disable budget checks (--no-budget). */
  noBudget?: boolean;
  /** Disable checkpoint tracking (--no-checkpoint). */
  noCheckpoint?: boolean;
  /** Checkpoint retention days (--checkpoint-retention). */
  checkpointRetention?: number;
  /** Checkpoint directory (--checkpoint-dir). */
  checkpointDir?: string;
  /** Enable git checkpoint (--git-checkpoint). */
  gitCheckpoint?: boolean;
  /** Disable memory loading (--no-memory). */
  noMemory?: boolean;
  /** Disable auto-memory writing (--no-auto-memory). */
  noAutoMemory?: boolean;
  configPath?: string;
  mcpServers?: McpServerFlag[];
  /** StreamingBus for real-time streaming output. Created externally. */
  streamingBus?: StreamingBus;
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
  const mcpRegistry = new McpRegistry(journal, runId);
  if (config.mcpServers && config.mcpServers.length > 0) {
    const results = await mcpRegistry.connect(
      config.mcpServers.map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
        riskLevel: s.riskLevel as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | undefined,
      })),
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

  // ── Plugins ───────────────────────────────────────────────────────────
  const pluginLoader = new PluginLoader({ journal, runId });
  const pluginResults = await pluginLoader.loadAll();
  for (const r of pluginResults) {
    if (r.status === "failed") {
      emit(renderSystemNotice(`Plugin "${r.pluginName}" failed: ${r.error}`, theme));
    }
  }
  // Register plugin tools into ToolRuntime.
  for (const tool of pluginLoader.getTools()) {
    toolRuntime.register(tool);
    permissionRuntime.allow({
      pattern: tool.name,
      riskLevel: tool.riskLevel ?? RiskLevel.LOW,
      description: `Plugin tool: ${tool.name}`,
    });
  }

  // ── Skills ────────────────────────────────────────────────────────────
  const skillRegistry = new SkillRegistry({ journal, runId });

  // Built-in skills (registered first — highest priority)
  let replClosing = false;
  // Lazy ref — set after HookRuntime is created below
  let hookRuntimeRef: InstanceType<typeof HookRuntime> | null = null;

  const builtinSkills = createBuiltinSkills({
    getToolNames: () => toolRuntime.getToolNames(),
    getMessageCount: () => messageHistory.length,
    getTurnCount: () => turnCount,
    providerName: config.providerName,
    journalPath,
    getPlugins: () => pluginLoader.getLoadedPlugins().map((p) => ({
      name: p.name, version: p.version, toolCount: p.tools.length,
    })),
    getHooks: () => {
      if (!hookRuntimeRef) return { rules: [], bypassTrust: false, disabled: true };
      const hookConfig = hookRuntimeRef.getConfig();
      const rules: Array<{ event: string; matcher: string; command: string }> = [];
      for (const [event, eventRules] of Object.entries(hookConfig.hooks)) {
        if (!eventRules) continue;
        for (const rule of eventRules) {
          for (const handler of rule.handlers) {
            rules.push({ event, matcher: rule.matcher ?? "*", command: handler.command });
          }
        }
      }
      return { rules, bypassTrust: config.bypassHookTrust ?? false, disabled: config.noHooks ?? false };
    },
    getUsageStatus: () => ({
      session: usageTracker.formatSessionStatus(),
      daily: usageTracker.formatDailyStatus(),
    }),
    getMemoryStore: () => memoryStore,
    clearMessages: () => {
      const count = messageHistory.length;
      messageHistory = SYSTEM_MESSAGE ? [{ ...SYSTEM_MESSAGE }] : [];
      turnCount = 0;
      return count - (SYSTEM_MESSAGE ? 1 : 0);
    },
    close: () => { replClosing = true; },
    registry: skillRegistry,
    getStreamingBus: () => streamingBus,
  });
  for (const skill of builtinSkills) skillRegistry.register(skill);

  // Plugin skills (from plugin module implementations)
  for (const plugin of pluginLoader.getLoadedPlugins()) {
    if (plugin.module?.skills) {
      for (const ps of plugin.module.skills) {
        skillRegistry.register({
          name: ps.name,
          description: ps.description ?? `Plugin skill: ${ps.name}`,
          handler: async (input: string) => {
            return ps.handler({ input, config: {} });
          },
        });
      }
    }
  }

  // User skill files (~/.helm/skills/)
  const userSkillEntries = await loadUserSkills();
  for (const entry of userSkillEntries) {
    if (entry.skill) {
      skillRegistry.register(entry.skill);
    } else if (entry.result.status === "failed") {
      emit(renderSystemNotice(`Skill file "${entry.result.skillName}" failed: ${entry.result.error}`, theme));
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
        // Skip if streaming already printed the text in real-time.
        if (streamedTextThisTurn) break;
        const text = String(e.content ?? "").trim();
        if (text) emit(theme.bold("● ") + text);
        break;
      }
      case "tool:call": {
        const toolName = String(e.toolName ?? "");
        const args = (e.args as Record<string, unknown>) ?? {};
        // Use runId+toolName as key; if multiple concurrent calls use same tool
        // the last call wins (acceptable approximation for sequential tools).
        const callKey = `${String(e.runId ?? "")}_${toolName}`;
        pendingCalls.set(callKey, {
          name: toolName,
          args,
          startMs: Date.now(),
        });

        // Pre-edit snapshot for checkpoint
        if (toolName === "write" || toolName === "edit") {
          const filePath = String(args.filePath ?? "");
          if (filePath) {
            try {
              const { readFileSync: rf } = await import("node:fs");
              const content = rf(resolve(filePath), "utf-8");
              preEditSnapshots.set(callKey, { files: [resolve(filePath)], content: [content] });
            } catch {
              // File may not exist yet (write tool) — snapshot with empty
              preEditSnapshots.set(callKey, { files: [resolve(filePath)], content: [""] });
            }
          }
        }

        statusState.currentTool = toolName;
        paintStatusBar();
        break;
      }
      case "tool:result": {
        const toolName = String(e.toolName ?? "");
        const callKey = `${String(e.runId ?? "")}_${toolName}`;
        const pending = pendingCalls.get(callKey);
        pendingCalls.delete(callKey);

        // Create checkpoint after successful file edit
        if ((toolName === "write" || toolName === "edit") && !String(e.output ?? "").startsWith("Error:")) {
          const snapshot = preEditSnapshots.get(callKey);
          preEditSnapshots.delete(callKey);
          if (snapshot && snapshot.files.length > 0) {
            const cp = checkpointMgr.createFromFileEdit(
              snapshot.files,
              messageHistory.length,
              pending?.args ? String((pending.args as Record<string, unknown>).filePath ?? "file edit") : "file edit",
            );
            if (cp) {
              await originalAppend({
                type: "checkpoint:create",
                runId,
                checkpointId: cp.id,
                checkpointType: "file_edit",
                files: snapshot.files,
                conversationIndex: messageHistory.length,
                timestamp: Date.now(),
              });
            }
          }
        } else {
          preEditSnapshots.delete(callKey);
        }

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
      case "plugin:load":
        emit(renderSystemNotice(`Plugin "${e.pluginName}" v${e.pluginVersion} loaded (${e.toolCount} tools)`, theme));
        break;
      case "plugin:error":
        emit(renderSystemNotice(`Plugin "${e.pluginName}" error: ${e.message}`, theme));
        break;
      case "skill:call":
        // Skill calls are silent — the skill handler produces its own output
        break;
      case "skill:error":
        emit(renderSystemNotice(`Skill "/${e.skillName}" error: ${e.message}`, theme));
        break;
      case "memory:load":
        // Silent — memory loading is background
        break;
      case "memory:write":
        emit(renderSystemNotice(`Memory written (${e.memoryType}${e.trigger ? `, trigger=${e.trigger}` : ""})`, theme));
        break;
      case "memory:clear":
        emit(renderSystemNotice(`Memory cleared (scope=${e.scope})`, theme));
        break;
      case "checkpoint:create":
        emit(renderSystemNotice(`Checkpoint ${e.checkpointId} (${e.checkpointType})`, theme));
        break;
      case "checkpoint:restore":
        emit(renderSystemNotice(`Restored to ${e.checkpointId} (${e.action})`, theme));
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
    if (replClosing) return;
    try {
      printStatusBar();
      frame.open(() => rl.prompt());
    } catch {
      // readline may have been closed between the guard and the call
    }
  };

  // ── Ctrl+X Ctrl+E chord state ─────────────────────────────────────────
  let ctrlXPending = false;

  // ── Bracketed paste ───────────────────────────────────────────────────
  const paste = new PasteBuffer();
  const pastedBlocks = new Map<string, string>();
  const isTTY = process.stdout.isTTY === true;
  if (isTTY) process.stdout.write(BRACKETED_PASTE_ON);

  // ── Completion menu state ──────────────────────────────────────────────
  interface MenuEntry { name: string; description: string }
  const menuState = { active: false, entries: [] as MenuEntry[], selected: 0, lineCount: 0 };

  function buildMenuEntries(): MenuEntry[] {
    const entries: MenuEntry[] = [];
    for (const s of skillRegistry.list()) {
      entries.push({ name: `/${s.name}`, description: s.description });
    }
    entries.push({ name: "/mode", description: "Switch permission strategy" });
    entries.push({ name: "/theme", description: "Switch theme" });
    entries.push({ name: "/compact", description: "Trigger compaction" });
    entries.push({ name: "/quit", description: "Alias for /exit" });
    entries.push({ name: "/q", description: "Alias for /exit" });
    return entries;
  }

  function renderCompletionMenu(): void {
    const entries = menuState.entries;
    const maxNameLen = Math.max(...entries.map((e) => e.name.length));
    const cols = Math.min(80, process.stdout.columns || 80);
    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const name = `${e.name.padEnd(maxNameLen)}`;
      if (i === menuState.selected) {
        lines.push(theme.accent("▸ ") + theme.bold(name) + "  " + e.description);
      } else {
        lines.push("  " + theme.dim(name) + "  " + theme.dim(e.description));
      }
    }
    lines.push(theme.dim("─".repeat(cols)));
    menuState.lineCount = lines.length;
    process.stdout.write("\n" + lines.join("\n"));
    // Move cursor back up to the input line
    process.stdout.write(`\x1b[${lines.length}A`);
  }

  function eraseCompletionMenu(): void {
    if (menuState.lineCount > 0) {
      // Move down past the menu, then erase upward
      process.stdout.write(`\x1b[${menuState.lineCount}B`);
      process.stdout.write(`\x1b[${menuState.lineCount}A\x1b[0J`);
      menuState.lineCount = 0;
    }
  }

  function activateMenu(): void {
    menuState.active = true;
    menuState.entries = buildMenuEntries();
    menuState.selected = 0;
    renderCompletionMenu();
  }

  function deactivateMenu(): void {
    menuState.active = false;
    eraseCompletionMenu();
  }

  process.stdin.on("keypress", (_chunk, key?: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (!key) return;

    // ── Completion menu navigation ──────────────────────────────────────
    if (menuState.active) {
      if (key.name === "up") {
        menuState.selected = (menuState.selected - 1 + menuState.entries.length) % menuState.entries.length;
        eraseCompletionMenu();
        renderCompletionMenu();
        return;
      }
      if (key.name === "down") {
        menuState.selected = (menuState.selected + 1) % menuState.entries.length;
        eraseCompletionMenu();
        renderCompletionMenu();
        return;
      }
      if (key.name === "return") {
        const selected = menuState.entries[menuState.selected]!;
        deactivateMenu();
        // Clear readline buffer so it doesn't emit a duplicate line event
        const rlI = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
        rlI.line = "";
        rlI.cursor = 0;
        rlI._refreshLine();
        // Manually process the selected command
        processInput(selected.name);
        return;
      }
      if (key.name === "escape") {
        deactivateMenu();
        return;
      }
      // Any other key — deactivate menu and let normal processing happen
      deactivateMenu();
    }

    // Show completion menu when "/" is the only character on the line
    if (!key.ctrl) {
      const rlI = rl as unknown as { line: string };
      if (rlI.line === "/" && !menuState.active) {
        setImmediate(() => activateMenu());
      }
    }

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
  // Build system prompt using PromptBuilder.
  const mcpInstructions = mcpRegistry.instructions();
  const promptBuilder = PromptBuilder.create()
    .registerBuiltins({
      agentName: "Helm",
      providerName: config.providerName,
      toolCount: toolRuntime.getToolNames().length,
      mcpInstructions: mcpInstructions || undefined,
    })
    .loadVarsFiles();

  // --prompt-file: load custom template
  if (config.promptFile) {
    promptBuilder.useTemplate(config.promptFile);
  }

  // --prompt-var: inject CLI variables
  if (config.promptVars && Object.keys(config.promptVars).length > 0) {
    promptBuilder.setVariables(config.promptVars);
  }

  // --output-style: apply output style
  if (config.outputStyle) {
    promptBuilder.applyOutputStyle(config.outputStyle);
  }

  // --append-prompt: append user text
  if (config.appendPrompt) {
    promptBuilder.append(config.appendPrompt);
  }

  // --system-prompt: direct override (null = no prompt, string = custom)
  if (config.systemPrompt !== undefined) {
    promptBuilder.setSystemPromptOverride(config.systemPrompt);
  }

  const builtPrompt = promptBuilder.build();
  const SYSTEM_MESSAGE: MessageRecord | null =
    builtPrompt.content ? { role: "system", content: builtPrompt.content } : null;

  let messageHistory: MessageRecord[] = SYSTEM_MESSAGE ? [SYSTEM_MESSAGE] : [];
  let turnCount = 0;

  // ── Streaming integration ───────────────────────────────────────────────
  const streamingBus = config.streamingBus;
  let streamedTextThisTurn = false;

  if (streamingBus) {
    streamingBus.on((event) => {
      if (event.type === "text_delta") {
        streamedTextThisTurn = true;
        process.stdout.write(event.text);
      }
    });
  }

  // ── Hook runtime ───────────────────────────────────────────────────────────
  const hookRuntime = new HookRuntime({
    projectRoot: process.cwd(),
    sessionId: `repl_${Date.now()}`,
    cwd: process.cwd(),
    bypassTrust: config.bypassHookTrust ?? false,
    disabledEvents: new Set((config.disableHook ?? []) as HookEvent[]),
    disabled: config.noHooks ?? false,
  });
  hookRuntimeRef = hookRuntime;

  // ── Telemetry ──────────────────────────────────────────────────────────────
  const telemetryConfig = loadTelemetryConfig();
  if (config.noTelemetry) telemetryConfig.enabled = false;
  if (config.telemetryVerbose) telemetryConfig.verbose = true;
  const telemetry = new TelemetryManager(telemetryConfig);
  const sessionId = `repl-${Date.now()}`;
  telemetry.startSession(sessionId, config.providerName, config.providerName);

  // ── Usage Tracker ──────────────────────────────────────────────────────────
  const usageTracker = new UsageTracker(
    config.providerName,
    config.providerName,
    {
      enabled: !config.noBudget,
      budgetConfig: {
        session_limit: config.budgetSession,
        daily_limit: config.budgetDaily,
        monthly_limit: config.budgetMonthly,
        warning_threshold: config.budgetWarning ?? 0.8,
      },
    },
  );

  // ── Memory Store ─────────────────────────────────────────────────────────────
  const memoryStore = config.noMemory ? undefined : new MemoryStore();

  // Load memory and inject into system prompt
  if (memoryStore && SYSTEM_MESSAGE) {
    const memResult = memoryStore.load();

    // Emit journal events for loaded files
    for (const entry of memResult.instructions) {
      await journal.append({
        type: "memory:load",
        runId,
        source: entry.source,
        scope: entry.scope === "session" ? "project" : entry.scope,
        lines: entry.content.split("\n").length,
        timestamp: Date.now(),
      });
    }
    for (const entry of memResult.auto) {
      await journal.append({
        type: "memory:load",
        runId,
        source: entry.source,
        scope: "project",
        lines: entry.content.split("\n").length,
        timestamp: Date.now(),
      });
    }

    // Inject memory into system prompt
    const instructionText = memoryStore.getInstructionText();
    const autoText = memoryStore.getAutoText();
    const memoryParts: string[] = [];
    if (instructionText) memoryParts.push(instructionText);
    if (autoText) memoryParts.push("## Auto Memory\n\n" + autoText);
    if (memoryParts.length > 0) {
      SYSTEM_MESSAGE.content += "\n\n" + memoryParts.join("\n\n");
    }
  }

  // ── Checkpoint Manager ────────────────────────────────────────────────────
  const checkpointMgr = new CheckpointManager({
    sessionId: runId,
    checkpointDir: config.checkpointDir,
    retentionDays: config.checkpointRetention,
    enabled: !config.noCheckpoint,
  });

  // Create session-start checkpoint
  checkpointMgr.createSessionStart(0);
  await journal.append({
    type: "checkpoint:create",
    runId,
    checkpointId: "cp-001",
    checkpointType: "session_start",
    files: [],
    conversationIndex: 0,
    timestamp: Date.now(),
  });

  // Snapshot buffer: stores file snapshots before tool execution
  // Keyed by tool call ID, so we can create checkpoint after successful edit
  const preEditSnapshots = new Map<string, { files: string[]; content: string[] }>();

  // ── Session start hook ─────────────────────────────────────────────────────
  try {
    const sessionResult = await hookRuntime.execute("session:start");
    if (sessionResult) {
      // Journal hook results
      for (const hr of sessionResult.results) {
        if (hr.error) {
          await journal.append({
            type: "hook:error",
            runId: `repl-${Date.now()}`,
            turnIndex: 0,
            hookEvent: "session:start",
            error: hr.error,
            durationMs: hr.durationMs,
            timestamp: Date.now(),
          });
        } else {
          await journal.append({
            type: "hook:execute",
            runId: `repl-${Date.now()}`,
            turnIndex: 0,
            hookEvent: "session:start",
            status: hr.timedOut ? "timeout" : "success",
            durationMs: hr.durationMs,
            timestamp: Date.now(),
          });
        }
      }

      if (sessionResult.systemMessages.length > 0) {
        const sessionMsg = sessionResult.systemMessages.join("\n");
        if (SYSTEM_MESSAGE) {
          SYSTEM_MESSAGE.content += "\n\n" + sessionMsg;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // ── Welcome box ───────────────────────────────────────────────────────
  const home = process.env.HOME ?? "";
  const tilde = (p: string): string => home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  const toolNames = toolRuntime.getToolNames();
  const tips: string[] = [
    `${theme.dim("Provider")}  ${config.providerName}`,
    `${theme.dim("Tools")}     ${toolNames.length}`,
  ];
  if (pluginLoader.count > 0) tips.push(`${theme.dim("Plugins")}   ${pluginLoader.count}`);
  if (config.configPath) tips.push(`${theme.dim("Config")}    ${tilde(config.configPath)}`);
  tips.push(`${theme.dim("Journal")}   ${tilde(journalPath)}`);
  const hookCount = Object.values(hookRuntime.getConfig().hooks).reduce((sum, rules) => sum + (rules?.length ?? 0), 0);
  if (hookCount > 0) tips.push(`${theme.dim("Hooks")}     ${hookCount} rule(s)`);
  if (memoryStore) {
    const memSummary = memoryStore.summary();
    const memTotal = memSummary.instructions + memSummary.auto + memSummary.rules;
    if (memTotal > 0) tips.push(`${theme.dim("Memory")}   ${memTotal} entry/ies`);
  }
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
  // Build command list dynamically from registered skills + direct handlers
  const DIRECT_COMMANDS = ["/mode", "/theme", "/compact", "/rewind", "/checkpoint"];
  const COMMANDS = [...DIRECT_COMMANDS, ...skillRegistry.list().map((s: { name: string }) => `/${s.name}`), "/quit", "/q"];

  function makeSkillContext() {
    const tools = new Map<string, Tool>();
    for (const t of toolRuntime.list()) tools.set(t.name, t);
    return {
      tools,
      messages: messageHistory as unknown as Message[],
      addMessage: (msg: Message) => {
        messageHistory.push(msg as MessageRecord);
      },
      runId,
    };
  }

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

      // Direct handlers for commands that interact with REPL internal state
      switch (cmd) {
        case "/quit": case "/q":
          replClosing = true;
          console.log(theme.bold("Goodbye."));
          rl.close();
          return;

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

        case "/rewind": {
          const checkpoints = checkpointMgr.list();
          if (checkpoints.length === 0) {
            console.log(theme.dim("No checkpoints available."));
            hr(); reprompt(); return;
          }

          // Show rewind menu
          const W = 52;
          const b = theme.accent;
          const reset = theme.reset;
          console.log(`${b}╭─ Rewind ${"─".repeat(W - 10)}╮${reset}`);
          for (let i = checkpoints.length - 1; i >= 0; i--) {
            const cp = checkpoints[i]!;
            const marker = i === checkpoints.length - 1 ? ">" : " ";
            const id = cp.id.padEnd(12);
            const desc = cp.description.length > 32 ? cp.description.slice(0, 31) + "…" : cp.description.padEnd(32);
            const time = new Date(cp.timestamp).toLocaleTimeString();
            console.log(`${b}│${reset} ${marker} ${theme.bold(id)} ${desc} ${theme.dim(time)} ${b}│${reset}`);
          }
          console.log(`${b}╰${"─".repeat(W)}╯${reset}`);
          console.log("");
          console.log("Select action:");
          console.log("  1. Restore code and conversation");
          console.log("  2. Restore conversation only");
          console.log("  3. Restore code only");
          console.log("  4. Summarize from here");
          console.log("  5. Summarize up to here");
          console.log("  6. Cancel");
          console.log("");
          console.log(theme.dim("Usage: /rewind <checkpoint-id> <1-6>"));
          hr(); reprompt(); return;
        }

        case "/checkpoint": {
          const subcmd = parts[1];
          if (subcmd === "list" || !subcmd) {
            const checkpoints = checkpointMgr.list();
            if (checkpoints.length === 0) {
              console.log(theme.dim("No checkpoints."));
            } else {
              console.log(theme.bold(`Checkpoints (${checkpoints.length}):`));
              for (const cp of checkpoints) {
                const time = new Date(cp.timestamp).toLocaleTimeString();
                console.log(`  ${theme.bold(cp.id)} [${cp.type}] ${cp.description} ${theme.dim(time)} (${cp.fileCount} files)`);
              }
            }
          } else if (subcmd === "restore" && parts[2]) {
            const cpId = parts[2];
            const action = (parts[3] ?? "code+conversation") as "code+conversation" | "conversation" | "code";
            const result = checkpointMgr.restore(cpId, action);
            if (result) {
              await journal.append({
                type: "checkpoint:restore",
                runId,
                checkpointId: cpId,
                action,
                filesRestored: result.filesRestored,
                timestamp: Date.now(),
              });
              console.log(theme.dim(`Restored ${result.filesRestored.length} files to ${cpId}`));
            } else {
              console.log(theme.dim(`Checkpoint "${cpId}" not found.`));
            }
          } else if (subcmd === "clean") {
            const removed = checkpointMgr.clean();
            await journal.append({
              type: "checkpoint:clean",
              runId,
              removed,
              timestamp: Date.now(),
            });
            console.log(theme.dim(`Cleaned ${removed} expired checkpoint(s).`));
          } else {
            console.log("Usage: /checkpoint [list|restore <id> [action]|clean]");
          }
          hr(); reprompt(); return;
        }
      }

      // Just "/" — activate interactive menu
      if (trimmed === "/") {
        activateMenu();
        reprompt(); return;
      }

      // Skill dispatch — handles /help, /tools, /clear, /exit, /plugins, /stats, and user skills
      const parsed = parseSkillInput(trimmed);
      const skillInput = parsed.input;
      const skillCtx = makeSkillContext();
      const result = await skillRegistry.execute(parsed.name, skillInput, skillCtx);
      if (result) console.log(result);
      if (replClosing) {
        console.log(theme.bold("Goodbye."));
        rl.close();
        return;
      }
      hr(); reprompt(); return;
    }

    // ── Agent turn ─────────────────────────────────────────────────────
    if (sm.state !== "idle") {
      sm.enqueue(trimmed);
      emit(theme.dim("⏳ Queued — waiting for current turn to finish"));
      return;
    }

    turnCount++;
    sm.send("sending");

    // Create prompt checkpoint
    const promptCp = checkpointMgr.createFromPrompt(trimmed, messageHistory.length);
    if (promptCp) {
      await journal.append({
        type: "checkpoint:create",
        runId,
        checkpointId: promptCp.id,
        checkpointType: "prompt",
        files: [],
        conversationIndex: messageHistory.length,
        timestamp: Date.now(),
      });
    }
    streamedTextThisTurn = false;
    streamingBus?.emit({ type: "turn_start", turnIndex: turnCount });

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
        hookRuntime,
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
        if (streamedTextThisTurn) {
          // Streaming already printed the text in real-time.
          // Just print a newline separator and duration.
          const durationMs = Date.now() - statusState.turnStart;
          const stats = streamingBus?.stats;
          const statsLine = stats
            ? theme.dim(`  ↳ ${stats.textTokens} tokens, ${stats.toolCallDeltaCount} tool calls, ${(durationMs / 1000).toFixed(1)}s`)
            : theme.dim(`  ↳ ${(durationMs / 1000).toFixed(1)}s`);
          console.log("\n" + statsLine);
        } else {
          const durationMs = Date.now() - statusState.turnStart;
          console.log("\n" + renderAssistantCard(lastMessage.content, durationMs, pickVerb(turnCount - 1), theme));
        }
      }

      messageHistory = result.messages;
      statusState.durationMs = Date.now() - statusState.turnStart;
      statusState.currentTool = null;
      statusState.turnStart = 0;
      streamingBus?.emit({ type: "turn_end", turnIndex: turnCount });
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
      if (replClosing) return;
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
    pluginLoader.destroyAll().catch(() => {});
    telemetry.endSession();
    telemetry.shutdown();
    journal.close().catch(() => {});
    console.log(theme.dim(`\nJournal → ${journalPath}`));
  });

  return new Promise<void>((resolve) => { rl.on("close", resolve); });
}

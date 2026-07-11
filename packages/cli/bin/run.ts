#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonlJournal,
  RiskLevel,
  TokenBudget,
  StreamingBus,
  type PermissionPolicy,
  type NonInteractiveStrategy,
} from "@helm/core";
import type { Provider, Tool, Message } from "@helm/core";
import {
  ScriptedProvider,
  AgentLoop,
  ToolRuntime,
  PermissionRuntime,
  Compaction,
  CharTokenCounter,
  ContextBuilder,
  SubagentRuntime,
  createSubagentTool,
} from "@helm/runtime";
import type { CompactionStrategy } from "@helm/runtime";

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

interface ScriptLine {
  role: string;
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

interface PermRule {
  action: "allow" | "deny";
  pattern: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
}

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

function formatTime(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Claude CLI / VS Code style mcp.json schema. */
interface McpConfigFile {
  mcpServers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    riskLevel?: string;
  }>;
}

/** Load --mcp-config JSON file → McpServerFlag[] (name + command + args). */
function loadMcpConfig(configPath: string): Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; riskLevel?: string }> {
  const cfg = loadJson<McpConfigFile>(configPath);
  const result: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; riskLevel?: string }> = [];
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    result.push({
      name,
      command: server.command,
      args: server.args,
      env: server.env,
      riskLevel: server.riskLevel,
    });
  }
  return result;
}

const VALID_STRATEGIES: NonInteractiveStrategy[] = [
  "auto-approve",
  "auto-deny",
  "risk-threshold",
];

function isNonInteractiveStrategy(
  s: string,
): s is NonInteractiveStrategy {
  return (VALID_STRATEGIES as string[]).includes(s);
}

const EXIT_PERMISSION_DENIED = 2;

// ── Config file: ~/.helm/settings.json (like ~/.claude/settings.json) ──────

interface HelmSettings {
  provider?: "scripted" | "deepseek";
  model?: string;
  /** API key inline. */
  apiKey?: string;
  /** System prompt. null = no system message. Omit = auto-derived. */
  systemPrompt?: string | null;
  tools?: string;
  perms?: string;
  workspace?: string;
  nonInteractive?: "auto-approve" | "auto-deny" | "risk-threshold";
  riskThreshold?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  compaction?: "summarize" | "truncate";
  compactionKeepTurns?: number;
  tokenBudget?: number;
  maxTurns?: number;
}

function loadSettings(): HelmSettings {
  const candidates = [
    resolve(process.cwd(), ".helm", "settings.json"),
    resolve(process.env.HOME ?? "/tmp", ".helm", "settings.json"),
    // Backward-compat
    resolve(process.cwd(), ".helmrc.json"),
    resolve(process.env.HOME ?? "/tmp", ".helmrc.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, "utf-8")) as HelmSettings;
      }
    } catch {
      // Non-fatal
    }
  }
  return {};
}

// ── REPL argument parsing ─────────────────────────────────────────────────

function parseReplArgs(
  args: string[],
  base: HelmSettings = {},
): {
  providerKind: "scripted" | "deepseek";
  model?: string;
  apiKey?: string;
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
  mcpServers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; riskLevel?: string }>;
} {
  // Apply config file first, CLI flags override
  let providerKind: "scripted" | "deepseek" = base.provider ?? "scripted";
  let model: string | undefined = base.model;
  let apiKey: string | undefined = base.apiKey;
  let systemPrompt: string | null | undefined = base.systemPrompt;
  let toolsPath: string | undefined = base.tools;
  let permsPath: string | undefined = base.perms;
  let workspaceRoot: string | undefined = base.workspace;

  // --system-prompt flag override
  for (const arg of args) {
    if (arg.startsWith("--system-prompt=")) {
      systemPrompt = arg.slice("--system-prompt=".length);
    }
  }
  let nonInteractive: NonInteractiveStrategy | undefined;
  let riskThreshold: RiskLevel | undefined;
  let compaction: CompactionStrategy | undefined = base.compaction;
  let compactionKeepTurns = base.compactionKeepTurns ?? 2;
  let tokenBudgetMax: number | undefined = base.tokenBudget;
  let maxTurns = base.maxTurns ?? 20;
  const mcpServers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; riskLevel?: string }> = [];

  if (base.nonInteractive && isNonInteractiveStrategy(base.nonInteractive)) {
    nonInteractive = base.nonInteractive;
  }
  if (
    base.riskThreshold &&
    base.riskThreshold in RiskLevel
  ) {
    riskThreshold = RiskLevel[base.riskThreshold];
  }

  for (const arg of args) {
    if (arg.startsWith("--provider=")) {
      const p = arg.slice("--provider=".length);
      if (p !== "scripted" && p !== "deepseek") {
        console.error(`Invalid --provider: ${p}. Must be scripted or deepseek.`);
        process.exit(1);
      }
      providerKind = p;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg.startsWith("--api-key=")) {
      apiKey = arg.slice("--api-key=".length);
    } else if (arg.startsWith("--tools=")) {
      toolsPath = arg.slice("--tools=".length);
    } else if (arg.startsWith("--perms=")) {
      permsPath = arg.slice("--perms=".length);
    } else if (arg.startsWith("--workspace=")) {
      workspaceRoot = arg.slice("--workspace=".length);
    } else if (arg.startsWith("--non-interactive=")) {
      const s = arg.slice("--non-interactive=".length);
      if (!isNonInteractiveStrategy(s)) {
        console.error(`Invalid --non-interactive: ${s}`);
        process.exit(1);
      }
      nonInteractive = s;
    } else if (arg.startsWith("--risk-threshold=")) {
      const level = arg.slice("--risk-threshold=".length);
      if (!(level in RiskLevel)) {
        console.error(`Invalid --risk-threshold: ${level}`);
        process.exit(1);
      }
      riskThreshold = RiskLevel[level as keyof typeof RiskLevel];
    } else if (arg.startsWith("--compaction=")) {
      const s = arg.slice("--compaction=".length);
      if (s !== "summarize" && s !== "truncate") {
        console.error(`Invalid --compaction: ${s}`);
        process.exit(1);
      }
      compaction = s;
    } else if (arg.startsWith("--compaction-keep-turns=")) {
      const v = Number(arg.slice("--compaction-keep-turns=".length));
      if (!Number.isInteger(v) || v < 1) process.exit(1);
      compactionKeepTurns = v;
    } else if (arg.startsWith("--token-budget=")) {
      const v = Number(arg.slice("--token-budget=".length));
      if (!Number.isFinite(v) || v <= 0) process.exit(1);
      tokenBudgetMax = v;
    } else if (arg.startsWith("--max-turns=")) {
      const v = Number(arg.slice("--max-turns=".length));
      if (!Number.isInteger(v) || v < 1) process.exit(1);
      maxTurns = v;
    } else if (arg.startsWith("--mcp-server=")) {
      const val = arg.slice("--mcp-server=".length);
      const eq = val.indexOf("=");
      if (eq === -1) {
        console.error(`Invalid --mcp-server: ${val}. Expected <name>=<command>`);
        process.exit(1);
      }
      const name = val.slice(0, eq);
      const cmdStr = val.slice(eq + 1);
      const parts = cmdStr.split(/\s+/);
      mcpServers.push({ name, command: parts[0]!, args: parts.slice(1) });
    } else if (arg.startsWith("--mcp-config=")) {
      const configPath = arg.slice("--mcp-config=".length);
      try {
        mcpServers.push(...loadMcpConfig(configPath));
      } catch (err) {
        console.error(`Failed to load --mcp-config: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  }

  return {
    providerKind,
    model,
    apiKey,
    toolsPath,
    permsPath,
    workspaceRoot,
    nonInteractive,
    riskThreshold,
    compaction,
    compactionKeepTurns,
    tokenBudgetMax,
    maxTurns,
    systemPrompt,
    mcpServers,
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);

  // Dispatch:
  //   `helm` / `helm repl` / `helm --flags` → REPL
  //   `helm run ...` / `helm tools.json ...` → batch
  const isRepl =
    rawArgs.length === 0 ||
    rawArgs[0] === "repl" ||
    rawArgs[0]?.startsWith("--");

  if (isRepl) {
    const replArgs = rawArgs[0] === "repl" ? rawArgs.slice(1) : rawArgs;
    const { startRepl } = await import("../src/repl.js");
    const config = loadSettings();

    // Detect which config file was found
    const cwdSettings = resolve(process.cwd(), ".helm", "settings.json");
    const homeSettings = resolve(
      process.env.HOME ?? "/tmp",
      ".helm",
      "settings.json",
    );
    const configPath =
      Object.keys(config).length > 0
        ? existsSync(cwdSettings)
          ? cwdSettings
          : existsSync(homeSettings)
            ? homeSettings
            : undefined
        : undefined;

    const parsed = parseReplArgs(replArgs, config);

    // Create streaming bus (shared between provider and REPL)
    const streamingBus = new StreamingBus();

    // Build provider
    let replProvider: Provider;
    let providerName: string;
    if (parsed.providerKind === "deepseek") {
      const apiKey =
        parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        console.error(
          "DeepSeek provider requires DEEPSEEK_API_KEY env var or --api-key flag.",
        );
        process.exit(1);
      }
      try {
        const mod = await import("@helm/provider-deepseek");
        const OpenAIC = (mod as Record<string, unknown>)
          .OpenAICompatibleProvider as new (opts: Record<string, unknown>) => Provider;
        providerName = parsed.model ?? "deepseek-v4-flash";
        replProvider = new OpenAIC({
          apiKey,
          model: providerName,
          streamingBus,
        });
      } catch {
        console.error(
          "Failed to load @helm/provider-deepseek. Falling back to ScriptedProvider.",
        );
        providerName = "scripted (fallback)";
        replProvider = new ScriptedProvider([]);
      }
    } else {
      providerName = "scripted";
      replProvider = new ScriptedProvider([]);
    }

    return startRepl({
      provider: replProvider,
      providerName,
      configPath,
      toolsPath: parsed.toolsPath,
      permsPath: parsed.permsPath,
      workspaceRoot: parsed.workspaceRoot,
      nonInteractive: parsed.nonInteractive,
      riskThreshold: parsed.riskThreshold,
      compaction: parsed.compaction,
      compactionKeepTurns: parsed.compactionKeepTurns,
      tokenBudgetMax: parsed.tokenBudgetMax,
      maxTurns: parsed.maxTurns,
      systemPrompt: parsed.systemPrompt,
      mcpServers: parsed.mcpServers,
      streamingBus,
    });
  }

  // `helm plugin add <npm-package>` → install plugin
  if (rawArgs[0] === "plugin") {
    const { installPlugin } = await import("@helm/plugin");
    const subcommand = rawArgs[1];
    if (subcommand === "add" && rawArgs[2]) {
      const npmPackage = rawArgs[2];
      console.log(`Installing plugin from npm: ${npmPackage}...`);
      try {
        const result = await installPlugin(npmPackage);
        console.log(`Plugin "${result.name}" v${result.version} installed to ${result.path}`);
      } catch (err) {
        console.error(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      console.error("Usage: helm plugin add <npm-package>");
      process.exit(1);
    }
    return;
  }

  // `helm run ...` → batch mode
  if (rawArgs[0] === "run") {
    rawArgs.shift(); // consume "run" subcommand
  }

  const positional: string[] = [];
  let timeoutMs: number | undefined;
  let turnDelayMs = 0;
  let nonInteractive: NonInteractiveStrategy | undefined;
  let riskThreshold: RiskLevel | undefined;
  let subagentEnabled = false;
  let subagentMaxDepth = 3;
  let subagentScriptPath: string | undefined;
  let compactionStrategy: CompactionStrategy | undefined;
  let compactionKeepTurns = 2;
  let tokenBudgetMax: number | undefined;

  const VALID_COMPACTION_STRATEGIES: CompactionStrategy[] = [
    "summarize",
    "truncate",
  ];

  for (const arg of rawArgs) {
    if (arg.startsWith("--non-interactive=")) {
      const strategy = arg.slice("--non-interactive=".length);
      if (!isNonInteractiveStrategy(strategy)) {
        console.error(
          `Invalid --non-interactive value: "${strategy}". Must be one of: ${VALID_STRATEGIES.join(", ")}`,
        );
        process.exit(1);
      }
      nonInteractive = strategy;
    } else if (arg.startsWith("--risk-threshold=")) {
      const level = arg.slice("--risk-threshold=".length);
      if (!(level in RiskLevel)) {
        console.error(
          `Invalid --risk-threshold value: "${level}". Must be one of: LOW, MEDIUM, HIGH, CRITICAL`,
        );
        process.exit(1);
      }
      riskThreshold = RiskLevel[level as keyof typeof RiskLevel];
    } else if (arg.startsWith("--compaction=")) {
      const s = arg.slice("--compaction=".length);
      if (
        !(VALID_COMPACTION_STRATEGIES as string[]).includes(s)
      ) {
        console.error(
          `Invalid --compaction value: "${s}". Must be one of: ${VALID_COMPACTION_STRATEGIES.join(", ")}`,
        );
        process.exit(1);
      }
      compactionStrategy = s as CompactionStrategy;
    } else if (arg.startsWith("--compaction-keep-turns=")) {
      const v = Number(arg.slice("--compaction-keep-turns=".length));
      if (!Number.isInteger(v) || v < 1) {
        console.error(
          `Invalid --compaction-keep-turns value: ${arg}. Must be an integer >= 1.`,
        );
        process.exit(1);
      }
      compactionKeepTurns = v;
    } else if (arg.startsWith("--token-budget=")) {
      const v = Number(arg.slice("--token-budget=".length));
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`Invalid --token-budget value: ${arg}`);
        process.exit(1);
      }
      tokenBudgetMax = v;
    } else if (arg === "--subagent") {
      subagentEnabled = true;
    } else if (arg.startsWith("--subagent-script=")) {
      subagentScriptPath = arg.slice("--subagent-script=".length);
    } else if (arg.startsWith("--subagent-max-depth=")) {
      const v = Number(arg.slice("--subagent-max-depth=".length));
      if (!Number.isInteger(v) || v < 1) {
        console.error(
          `Invalid --subagent-max-depth value: ${arg}. Must be an integer >= 1.`,
        );
        process.exit(1);
      }
      subagentMaxDepth = v;
    } else if (arg.startsWith("--timeout=")) {
      const v = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`Invalid --timeout value: ${arg}`);
        process.exit(1);
      }
      timeoutMs = v;
    } else if (arg === "--timeout") {
      console.error("--timeout requires a value, e.g. --timeout=5000");
      process.exit(1);
    } else if (arg.startsWith("--turn-delay-ms=")) {
      const v = Number(arg.slice("--turn-delay-ms=".length));
      if (!Number.isFinite(v) || v < 0) {
        console.error(`Invalid --turn-delay-ms value: ${arg}`);
        process.exit(1);
      }
      turnDelayMs = v;
    } else {
      positional.push(arg);
    }
  }

  // Validate risk-threshold strategy requires threshold
  if (nonInteractive === "risk-threshold" && riskThreshold === undefined) {
    console.error(
      "--non-interactive=risk-threshold requires --risk-threshold=<LOW|MEDIUM|HIGH|CRITICAL>",
    );
    process.exit(1);
  }

  if (positional.length < 3) {
    console.error(
      "Usage: helm run <tools.json> <script.jsonl> <perms.json> [runId] [flags]",
    );
    console.error("Flags:");
    console.error(
      "  --non-interactive=<auto-approve|auto-deny|risk-threshold>",
    );
    console.error(
      "  --risk-threshold=<LOW|MEDIUM|HIGH|CRITICAL>   (for risk-threshold strategy)",
    );
    console.error(
      "  --compaction=<summarize|truncate>              (enable smart compaction)",
    );
    console.error(
      "  --compaction-keep-turns=<n>                   (recent turns to keep, default: 2)",
    );
    console.error(
      "  --token-budget=<n>                            (token budget for compaction trigger)",
    );
    console.error(
      "  --subagent                                    (enable spawn_subagent tool)",
    );
    console.error(
      "  --subagent-max-depth=<n>                      (max nesting depth, default: 3)",
    );
    console.error("  --timeout=<ms>");
    console.error("  --turn-delay-ms=<ms>");
    process.exit(1);
  }

  const [toolsPath, scriptPath, permsPath] = positional;
  const runId = positional[3] ?? `run-${Date.now()}`;

  // 1. Load permissions
  const permRules = loadJson<PermRule[]>(permsPath);
  const permissionRuntime = new PermissionRuntime();
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

  // 2. Build permission policy (if non-interactive)
  let permissionPolicy: PermissionPolicy | undefined;
  if (nonInteractive) {
    permissionPolicy = {
      strategy: nonInteractive,
      riskThreshold,
    };
  }

  // 3. Load tools and register
  const toolDefs = loadJson<ToolDef[]>(toolsPath);
  const toolRuntime = new ToolRuntime(permissionRuntime, permissionPolicy);
  for (const td of toolDefs) {
    toolRuntime.register({
      name: td.name,
      description: td.description,
      parameters: td.parameters,
      riskLevel: td.riskLevel
        ? RiskLevel[td.riskLevel]
        : undefined,
      async execute(args: Record<string, unknown>) {
        // Simple echo for CLI demo — in production this is the real tool impl
        return JSON.stringify(Object.entries(args).map(([k, v]) => `${k}=${v}`));
      },
    });
  }

  // 4. Load script
  const rawScript = readFileSync(resolve(scriptPath), "utf-8").trim();
  const scriptLines: ScriptLine[] = rawScript
    .split("\n")
    .map((l) => JSON.parse(l));
  const messages: Message[] = scriptLines.map(
    (s) => ({ role: s.role, content: s.content, toolCalls: s.toolCalls }) as Message
  );

  const baseProvider = new ScriptedProvider(messages);
  const provider = turnDelayMs > 0
    ? {
        async send(msgs: Message[], signal?: AbortSignal): Promise<Message> {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, turnDelayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
          return baseProvider.send(msgs, signal);
        },
      }
    : baseProvider;

  // 5. Create journal
  const journalPath = `/tmp/helm-${runId}.jsonl`;
  const journal = new JsonlJournal(journalPath);
  await journal.open();

  // Intercept append to print in real time
  const originalAppend = journal.append.bind(journal) as (
    event: Record<string, unknown>,
  ) => Promise<void>;
  journal.append = async (event) => {
    const ts = formatTime();
    switch (event.type) {
      case "run:start":
        console.log(`🚀 [${ts}] RUN START    id=${event.runId}`);
        break;
      case "turn:start":
        console.log(`🔄 [${ts}] TURN ${event.turnIndex} START`);
        break;
      case "tool:call":
        console.log(
          `🔧 [${ts}] TOOL CALL    ${event.toolName}(${JSON.stringify(event.args)})`
        );
        break;
      case "tool:result": {
        const out = event.output as string;
        const icon = out.startsWith("Error: permission denied") ? "⛔" : "📤";
        console.log(
          `${icon} [${ts}] TOOL RESULT  ${out.length > 80 ? out.slice(0, 80) + "..." : out}`
        );
        break;
      }
      case "permission:allowed":
        console.log(`✅ [${ts}] PERM ALLOW   ${event.toolName}`);
        break;
      case "permission:denied":
        console.log(
          `⛔ [${ts}] PERM DENY    ${event.toolName} — ${event.reason}`,
        );
        break;
      case "error":
        console.log(`❌ [${ts}] ERROR        ${event.message}`);
        break;
      case "run:cancelled":
        console.log(`🛑 [${ts}] CANCELLED    reason=${event.reason}`);
        break;
      case "compaction":
        console.log(
          `🗜️  [${ts}] COMPACTION    strategy=${event.strategy} msgs ${event.messageCountBefore}→${event.messageCountAfter} tokens ${event.tokensEstimatedBefore}→${event.tokensEstimatedAfter}`,
        );
        break;
      case "subagent:spawn":
        console.log(
          `🤖 [${ts}] SUBAGENT SPAWN  parent=${event.runId} child=${event.childRunId}`,
        );
        break;
      case "subagent:complete":
        console.log(
          `🏁 [${ts}] SUBAGENT DONE   child=${event.runId} parent=${event.parentRunId} exitCode=${event.exitCode}`,
        );
        break;
      case "run:end":
        console.log(`✅ [${ts}] RUN END      exitCode=${event.exitCode}`);
        break;
    }
    await originalAppend(event);
  };

  // 6. Run!
  const modeLabel = [
    nonInteractive
      ? `non-interactive (${nonInteractive}${riskThreshold ? `, threshold=${riskThreshold}` : ""})`
      : "interactive",
    compactionStrategy
      ? `compaction=${compactionStrategy}, keep=${compactionKeepTurns}, budget=${tokenBudgetMax ?? 4096}`
      : null,
    subagentEnabled
      ? `subagent, maxDepth=${subagentMaxDepth}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Helm CLI — runId: ${runId}`);
  console.log(
    `Tools: ${toolRuntime.getToolNames().length}, Script: ${scriptLines.length}, Perms: ${permRules.length}` +
      (timeoutMs !== undefined ? `, Timeout: ${timeoutMs}ms` : "") +
      `, Mode: ${modeLabel}`,
  );
  console.log(`Journal: ${journalPath}`);
  console.log(`${"=".repeat(50)}\n`);

  // 7. Signal setup (before subagent/AgentLoop — both need it)
  const sigintController = new AbortController();
  const onSigint = () => {
    console.log("\n^C received — cancelling run...");
    sigintController.abort();
  };
  process.on("SIGINT", onSigint);

  let tokenBudget: TokenBudget | undefined;
  let compaction: Compaction | undefined;
  let contextBuilder: ContextBuilder | undefined;

  if (compactionStrategy) {
    const tokenCounter = new CharTokenCounter();
    contextBuilder = new ContextBuilder(tokenCounter);
    const budgetMax = tokenBudgetMax ?? 4096;

    tokenBudget = new TokenBudget(budgetMax);

    // When summarizing, give compaction its own ScriptedProvider so it
    // doesn't consume responses meant for the main agent loop.
    const compactionProvider =
      compactionStrategy === "summarize"
        ? new ScriptedProvider([
            {
              role: "assistant" as const,
              content:
                "[Compaction summary] Previous conversation covered tool calls and their results. The agent completed several tasks successfully.",
            },
          ])
        : undefined;

    compaction = new Compaction({
      strategy: compactionStrategy,
      provider: compactionProvider,
      tokenCounter,
      keepRecentTurns: compactionKeepTurns,
    });
  }

  // 8. Wire up subagent support (if --subagent flag)
  if (subagentEnabled) {
    // Subagent gets its own ScriptedProvider so it doesn't
    // consume responses meant for the parent agent.
    let subagentProvider = baseProvider;
    if (subagentScriptPath) {
      const rawChildScript = readFileSync(
        resolve(subagentScriptPath),
        "utf-8",
      ).trim();
      const childScriptLines: ScriptLine[] = rawChildScript
        .split("\n")
        .map((l) => JSON.parse(l));
      const childMessages: Message[] = childScriptLines.map(
        (s) =>
          ({
            role: s.role,
            content: s.content,
            toolCalls: s.toolCalls,
          }) as Message,
      );
      subagentProvider = new ScriptedProvider(childMessages);
    }

    const subagentRuntime = new SubagentRuntime({
      provider: subagentProvider,
      journalPath,
      toolRuntime,
      permissionRuntime,
      permissionPolicy,
      maxDepth: subagentMaxDepth,
      signal: sigintController.signal,
    });

    toolRuntime.register(
      createSubagentTool(subagentRuntime, runId, 0),
    );
  }

  const loop = new AgentLoop(provider, toolRuntime, journal, {
    maxTurns: 10,
    signal: sigintController.signal,
    maxDurationMs: timeoutMs,
    tokenBudget,
    contextBuilder,
    compaction,
  });
  const result = await loop.run(runId, "User request (script-driven)");

  process.off("SIGINT", onSigint);
  await journal.close();
  console.log(`\nDone. Journal → ${journalPath}`);

  // Determine exit code
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
  if (result.permissionDenied) {
    process.exit(EXIT_PERMISSION_DENIED);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});

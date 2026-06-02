#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { JsonlJournal, RiskLevel } from "@helm/core";
import type { Tool, Message } from "@helm/core";
import {
  ScriptedProvider,
  AgentLoop,
  ToolRuntime,
  PermissionRuntime,
} from "@helm/runtime";

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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

async function main() {
  const rawArgs = process.argv.slice(2);
  const positional: string[] = [];
  let timeoutMs: number | undefined;
  let turnDelayMs = 0;
  for (const arg of rawArgs) {
    if (arg.startsWith("--timeout=")) {
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

  if (positional.length < 3) {
    console.error(
      "Usage: helm run <tools.json> <script.jsonl> <perms.json> [runId] [--timeout=<ms>]"
    );
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

  // 2. Load tools and register
  const toolDefs = loadJson<ToolDef[]>(toolsPath);
  const toolRuntime = new ToolRuntime(permissionRuntime);
  for (const td of toolDefs) {
    toolRuntime.register({
      name: td.name,
      description: td.description,
      parameters: td.parameters,
      async execute(args: Record<string, unknown>) {
        // Simple echo for CLI demo — in production this is the real tool impl
        return JSON.stringify(Object.entries(args).map(([k, v]) => `${k}=${v}`));
      },
    });
  }

  // 3. Load script
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

  // 4. Create journal
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
        console.log(
          `📤 [${ts}] TOOL RESULT  ${out.length > 80 ? out.slice(0, 80) + "..." : out}`
        );
        break;
      }
      case "error":
        console.log(`❌ [${ts}] ERROR        ${event.message}`);
        break;
      case "run:cancelled":
        console.log(`🛑 [${ts}] CANCELLED    reason=${event.reason}`);
        break;
      case "run:end":
        console.log(`✅ [${ts}] RUN END      exitCode=${event.exitCode}`);
        break;
    }
    await originalAppend(event);
  };

  // 5. Run!
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Helm CLI — runId: ${runId}`);
  console.log(
    `Tools: ${toolDefs.length}, Script: ${scriptLines.length}, Perms: ${permRules.length}` +
      (timeoutMs !== undefined ? `, Timeout: ${timeoutMs}ms` : "")
  );
  console.log(`Journal: ${journalPath}`);
  console.log(`${"=".repeat(50)}\n`);

  const sigintController = new AbortController();
  const onSigint = () => {
    console.log("\n^C received — cancelling run...");
    sigintController.abort();
  };
  process.on("SIGINT", onSigint);

  const loop = new AgentLoop(provider, toolRuntime, journal, {
    maxTurns: 10,
    signal: sigintController.signal,
    maxDurationMs: timeoutMs,
  });
  const result = await loop.run(runId, "User request (script-driven)");

  process.off("SIGINT", onSigint);
  await journal.close();
  console.log(`\nDone. Journal → ${journalPath}`);
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});

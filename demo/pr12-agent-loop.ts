// PR12 Demo: AgentLoop + DeepSeek integration (needs DEEPSEEK_API_KEY)
import { JsonlJournal } from "../packages/core/dist/index.js";
import { AgentLoop, ToolRuntime, registerFileTools } from "../packages/runtime/dist/index.js";
import { OpenAICompatibleProvider } from "../packages/provider-deepseek/dist/index.js";
import { getApiKey } from "./api-key.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";

// Create temp workspace
const dir = mkdtempSync(join(tmpdir(), "helm-pr12-"));
const jp = join(dir, "journal.jsonl");
const journal = new JsonlJournal(jp);
await journal.open();

// Set up ToolRuntime + file tools
const tr = new ToolRuntime();
registerFileTools(tr, dir);

// Create real provider + AgentLoop
const provider = new OpenAICompatibleProvider({ apiKey: getApiKey() });
const loop = new AgentLoop(provider, tr, journal, { maxTurns: 5 });

console.log("=== AgentLoop + DeepSeek: 文件读取 ===");
console.log("Workspace:", dir);
console.log("");

// Write a file in the workspace
writeFileSync(join(dir, "hello.txt"), "Hello from PR12!");

const result = await loop.run("pr12-demo", "Read the file hello.txt and tell me what it says.");
await journal.close();

console.log("Exit Code:", result.exitCode);
console.log("");

// Print journal
const events = (await readFile(jp, "utf-8")).trim().split("\n").map(l => JSON.parse(l));
console.log("=== Journal Trace ===");
for (const e of events) {
  let extra = "";
  if (e.type === "tool:call") extra = " tool=" + e.toolName + " args=" + JSON.stringify(e.args);
  if (e.type === "tool:result") extra = " output=" + (typeof e.output === "string" ? e.output.slice(0, 100) : String(e.output).slice(0, 100));
  console.log("  [" + e.type + "]" + extra);
}

rmSync(dir, { recursive: true, force: true });

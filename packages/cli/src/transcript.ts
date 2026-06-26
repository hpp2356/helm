// packages/cli/src/transcript.ts
import type { Theme } from "./theme.js";

const WORK_VERBS = ["Cooked","Baked","Brewed","Simmered","Forged","Conjured","Pondered","Crafted"];

export function pickVerb(turnIndex: number): string {
  return WORK_VERBS[turnIndex % WORK_VERBS.length]!;
}

export function renderMd(text: string, theme: Theme): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        const code = text.slice(i + 3, end).replace(/^\n/, "");
        out += theme.dim("  │ " + code.replace(/\n/g, "\n  │ ")) + "\n";
        i = end + 3; continue;
      }
    }
    if (text[i] === "`" && text[i + 1] !== "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) { out += theme.dim(text.slice(i + 1, end)); i = end + 1; continue; }
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) { out += theme.bold(text.slice(i + 2, end)); i = end + 2; continue; }
    }
    if ((text[i] === "-" || text[i] === "*") && (i === 0 || text[i - 1] === "\n") && text[i + 1] === " ") {
      out += "  • "; i += 2; continue;
    }
    if (/\d/.test(text[i]!) && (i === 0 || text[i - 1] === "\n")) {
      const m = text.slice(i).match(/^(\d+)\.\s/);
      if (m) { out += `  ${m[1]}. `; i += m[0].length; continue; }
    }
    if (text.startsWith("### ", i)) {
      i += 4; const end = text.indexOf("\n", i);
      out += "\n" + theme.bold(end !== -1 ? text.slice(i, end) : text.slice(i)) + "\n";
      i = end !== -1 ? end : text.length; continue;
    }
    if (text.startsWith("## ", i) && !text.startsWith("### ", i)) {
      i += 3; const end = text.indexOf("\n", i);
      out += "\n" + theme.bold(end !== -1 ? text.slice(i, end) : text.slice(i)) + "\n";
      i = end !== -1 ? end : text.length; continue;
    }
    out += text[i]; i++;
  }
  return out;
}

export function renderUserCard(message: string, theme: Theme): string {
  return theme.user("▸") + " " + message;
}

export function renderAssistantCard(content: string, durationMs: number, verb: string, theme: Theme): string {
  const body = renderMd(content.trim(), theme);
  const lines = body.split("\n").map((l, i) => i === 0 ? theme.assistant("●") + " " + l : "  " + l);
  const secs = Math.max(1, Math.round(durationMs / 1000));
  const footer = theme.dim(`✻ ${verb} for ${secs}s`);
  return lines.join("\n") + "\n" + footer;
}

export interface ToolCardOptions {
  name: string;
  args?: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  summary?: string;
}

/** Format tool args as a short parenthesized preview, like: read(src/app.ts) */
function argsPreview(args: Record<string, unknown>): string {
  // Prefer path-like keys first; push content/body to last (too verbose)
  const PRIORITY = ["path", "filePath", "file", "pattern", "command", "query", "content"];
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const primary = PRIORITY.find((k) => k in args) ?? entries[0]![0];
  const val = String(args[primary] ?? "");
  // Truncate at 60 chars; replace newlines
  const display = val.replace(/\n.*/s, "…").slice(0, 60);
  return `(${display})`;
}

/**
 * Render a completed tool call as a single line:
 *   ⚙ toolName(args)   ✓  [42ms]
 *   └ result summary
 */
export function renderToolCard(opts: ToolCardOptions, theme: Theme): string {
  const { name, args, success, durationMs, summary } = opts;
  const icon = success ? theme.success("✓") : theme.error("✗");
  const ms = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const argStr = args ? argsPreview(args) : "";
  const header = theme.tool("⚙ " + name) + theme.dim(argStr) + "   " + icon + "  " + theme.dim(`[${ms}]`);
  if (!summary) return header;
  return header + "\n" + theme.dim("  └ " + summary);
}

export function renderToolResultCollapsed(lines: number, theme: Theme): string {
  return theme.dim(`└ 共 ${lines} 行 — 输入 /expand 查看全部`);
}

export function renderErrorCard(message: string, theme: Theme): string {
  return theme.error("✗") + " " + theme.error(message);
}

export function renderApprovalPrompt(toolName: string, args: string, riskLevel: string, theme: Theme): string {
  return [
    theme.warning("⚠ 需要权限确认"),
    `  ${theme.tool(toolName)}(${args})  ${theme.error(`[${riskLevel}]`)}`,
    `  Allow? [y/N]`,
  ].join("\n");
}

export function renderSystemNotice(message: string, theme: Theme): string {
  return theme.info("ℹ") + " " + theme.textMuted(message);
}

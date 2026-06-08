// packages/cli/src/status-bar.ts
import type { Theme } from "./theme.js";

export interface StatusBarOptions {
  theme: Theme;
  cols: number;
  model: string;
  mode: string;
  contextPct: number;
  cost: number | null;
  durationMs: number;
  currentTool: string | null;
  bgTasks: number;
}

function modelAbbr(model: string, maxLen: number): string {
  if (model.length <= maxLen) return model;
  const short = model.split("-")[0] ?? model;
  return short.length <= maxLen ? short : model.slice(0, maxLen);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtCost(cost: number | null): string {
  if (cost === null) return "n/a";
  return `~$${cost.toFixed(3)}`;
}

export function renderStatusBar(opts: StatusBarOptions): string {
  const { theme, cols, model, mode, contextPct, cost, durationMs, currentTool, bgTasks } = opts;

  const ctxColor = contextPct >= 95 ? theme.error
    : contextPct >= 80 ? (s: string) => theme.bold(theme.warning(s))
    : contextPct >= 50 ? theme.warning
    : theme.textMuted;

  const ctxStr = ctxColor(`${contextPct}%`);
  const durStr = theme.textMuted(fmtDuration(durationMs));
  const isAutoApprove = mode === "auto-approve" || mode === "auto-deny";
  const modeStr = isAutoApprove
    ? theme.error(`⚠ ${mode}`)
    : theme.textMuted(mode);
  const sep = theme.borderMuted(" │ ");

  if (cols >= 100) {
    const mShort = modelAbbr(model, 20);
    const parts: string[] = [theme.textMuted(mShort), modeStr, `ctx ${ctxStr}`];
    if (currentTool) parts.push(theme.tool(`⚙ ${currentTool}`));
    if (bgTasks > 0) parts.push(theme.textMuted(`${bgTasks}bg`));
    parts.push(theme.textMuted(fmtCost(cost)));
    parts.push(durStr);
    return parts.join(sep);
  }

  if (cols >= 80) {
    const mShort = modelAbbr(model, 12);
    const parts: string[] = [theme.textMuted(mShort), modeStr, ctxStr];
    if (currentTool) parts.push(theme.tool(`⚙ ${currentTool}`));
    parts.push(durStr);
    return parts.join(sep);
  }

  if (cols >= 60) {
    const mShort = modelAbbr(model, 8);
    return [theme.textMuted(mShort), ctxStr, durStr].join(sep);
  }

  const mAbbr = modelAbbr(model, 4);
  return [theme.textMuted(mAbbr), ctxStr, durStr].join(sep);
}

// packages/cli/src/theme.ts

export type Painter = (s: string) => string;

export interface Theme {
  text: Painter;
  textMuted: Painter;
  border: Painter;
  borderMuted: Painter;
  accent: Painter;
  success: Painter;
  warning: Painter;
  error: Painter;
  info: Painter;
  user: Painter;
  assistant: Painter;
  tool: Painter;
  diffAdded: Painter;
  diffRemoved: Painter;
  diffContext: Painter;
  bold: Painter;
  dim: Painter;
  italic: Painter;
  reset: string;
}

export type ColorLevel = "truecolor" | "ansi256" | "ansi16" | "no-color";

export function detectColorLevel(): ColorLevel {
  if (process.env.NO_COLOR !== undefined) return "no-color";
  if (process.env.FORCE_COLOR === "0") return "no-color";
  if (process.env.FORCE_COLOR === "1") return "ansi16";
  if (process.env.FORCE_COLOR === "2") return "ansi256";
  if (process.env.FORCE_COLOR === "3") return "truecolor";
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") return "truecolor";
  const term = process.env.TERM ?? "";
  if (term.includes("256color")) return "ansi256";
  if (term) return "ansi16";
  return "no-color";
}

function tc(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}
function a256(n: number): string {
  return `\x1b[38;5;${n}m`;
}
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

function painter(open: string): Painter {
  return (s: string) => `${open}${s}${RESET}`;
}
const identity: Painter = (s) => s;

export function buildTheme(level?: ColorLevel): Theme {
  const l = level ?? detectColorLevel();

  if (l === "no-color") {
    return {
      text: identity,
      textMuted: (s) => `${DIM}${s}${RESET}`,
      border: (s) => `${DIM}${s}${RESET}`,
      borderMuted: (s) => `${DIM}${s}${RESET}`,
      accent: (s) => `${BOLD}${s}${RESET}`,
      success: identity,
      warning: (s) => `${BOLD}${s}${RESET}`,
      error: identity,
      info: identity,
      user: identity,
      assistant: identity,
      tool: (s) => `${DIM}${s}${RESET}`,
      diffAdded: identity,
      diffRemoved: identity,
      diffContext: (s) => `${DIM}${s}${RESET}`,
      bold: (s) => `${BOLD}${s}${RESET}`,
      dim: (s) => `${DIM}${s}${RESET}`,
      italic: (s) => `${ITALIC}${s}${RESET}`,
      reset: RESET,
    };
  }

  if (l === "ansi16") {
    return {
      text: identity,
      textMuted: (s) => `${DIM}${s}${RESET}`,
      border: painter("\x1b[33m"),
      borderMuted: (s) => `${DIM}${s}${RESET}`,
      accent: painter("\x1b[33m"),
      success: painter("\x1b[32m"),
      warning: painter("\x1b[33m"),
      error: painter("\x1b[31m"),
      info: painter("\x1b[36m"),
      user: painter("\x1b[35m"),
      assistant: painter("\x1b[33m"),
      tool: (s) => `${DIM}${s}${RESET}`,
      diffAdded: painter("\x1b[32m"),
      diffRemoved: painter("\x1b[31m"),
      diffContext: (s) => `${DIM}${s}${RESET}`,
      bold: (s) => `${BOLD}${s}${RESET}`,
      dim: (s) => `${DIM}${s}${RESET}`,
      italic: (s) => `${ITALIC}${s}${RESET}`,
      reset: RESET,
    };
  }

  if (l === "ansi256") {
    return {
      text: identity,
      textMuted: painter(a256(242)),
      border: painter(a256(208)),
      borderMuted: painter(a256(237)),
      accent: painter(a256(208)),
      success: painter(a256(76)),
      warning: painter(a256(178)),
      error: painter(a256(196)),
      info: painter(a256(75)),
      user: painter(a256(141)),
      assistant: painter(a256(208)),
      tool: painter(a256(242)),
      diffAdded: painter(a256(76)),
      diffRemoved: painter(a256(196)),
      diffContext: painter(a256(242)),
      bold: (s) => `${BOLD}${s}${RESET}`,
      dim: (s) => `${DIM}${s}${RESET}`,
      italic: (s) => `${ITALIC}${s}${RESET}`,
      reset: RESET,
    };
  }

  // truecolor
  return {
    text: identity,
    textMuted: painter(tc(107, 114, 128)),
    border: painter(tc(249, 115, 22)),
    borderMuted: painter(tc(55, 65, 81)),
    accent: painter(tc(249, 115, 22)),
    success: painter(tc(34, 197, 94)),
    warning: painter(tc(234, 179, 8)),
    error: painter(tc(239, 68, 68)),
    info: painter(tc(96, 165, 250)),
    user: painter(tc(167, 139, 250)),
    assistant: painter(tc(249, 115, 22)),
    tool: painter(tc(107, 114, 128)),
    diffAdded: painter(tc(34, 197, 94)),
    diffRemoved: painter(tc(239, 68, 68)),
    diffContext: painter(tc(107, 114, 128)),
    bold: (s) => `${BOLD}${s}${RESET}`,
    dim: (s) => `${DIM}${s}${RESET}`,
    italic: (s) => `${ITALIC}${s}${RESET}`,
    reset: RESET,
  };
}

export const theme: Theme = buildTheme();

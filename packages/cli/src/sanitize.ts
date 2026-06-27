// packages/cli/src/sanitize.ts

const STRIP_PATTERNS = [
  // Cursor movement: ESC[<n>A/B/C/D/E/F/G/H/f/s/u
  /\x1b\[\d*[ABCDEFGHfsu]/g,
  // Erase: ESC[J ESC[K (with optional numeric prefix)
  /\x1b\[\d*[JK]/g,
  // Alt screen: ESC[?1049h/l
  /\x1b\[\?1049[hl]/g,
  // Mouse reporting: ESC[?1000h/l ESC[?1002h/l ESC[?1003h/l
  /\x1b\[\?100[023][hl]/g,
  // Bracketed paste: ESC[?2004h/l
  /\x1b\[\?2004[hl]/g,
  // OSC sequences: ESC]...BEL or ESC]...ST
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  // Private mode sequences ESC[?<n>h/l (cursor hide/show, etc.)
  /\x1b\[\?[\d;]*[hl]/g,
  // Other ESC[ sequences that don't end in 'm' (non-SGR)
  /\x1b\[[\d;]*[^m\d;]/g,
];

export function sanitize(text: string): string {
  let out = text;
  for (const pat of STRIP_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out;
}

export function isBinary(buf: Buffer): boolean {
  if (buf.includes(0x00)) return true;
  let nonPrintable = 0;
  const sample = buf.slice(0, 512);
  for (const b of sample) {
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

export interface CollapseResult {
  collapsed: boolean;
  text: string;
  summary: string;
}

const COLLAPSE_THRESHOLD = 200;
const PREVIEW_LINES = 5;

export function collapseOutput(text: string): CollapseResult {
  const lines = text.split("\n");
  if (lines.length <= COLLAPSE_THRESHOLD) {
    return { collapsed: false, text, summary: "" };
  }
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const summary = `└ 共 ${lines.length} 行 — 输入 /expand 查看全部`;
  return { collapsed: true, text: preview, summary };
}

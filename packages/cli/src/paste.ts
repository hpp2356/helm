/**
 * Bracketed-paste buffering for the REPL.
 *
 * The problem this solves (see the screenshot bug): Node's readline has NO
 * paste support. When you paste a multi-line block, every embedded "\n" fires
 * its own "line" event, so a pasted prompt is split line-by-line and the REPL
 * runs one agent turn PER LINE — spawning a cascade of spinners and prompts.
 *
 * The fix: turn on the terminal's *bracketed paste mode* (ESC[?2004h). The
 * terminal then wraps any paste in paste-start / paste-end markers, which
 * Node's keypress decoder surfaces as `paste-start` / `paste-end` keypress
 * events. We buffer everything between them and hand it back as ONE block, so
 * the whole paste becomes a single submission.
 *
 * On screen a multi-line block can't live on readline's single-row prompt, so
 * it's collapsed to a one-line placeholder ("[Pasted N lines]") and expanded
 * back to the real text when the user finally presses Enter.
 *
 * This module holds the pure, side-effect-free pieces so they can be unit
 * tested without a TTY; repl.ts wires the terminal I/O around them.
 */

/** Tell the terminal to bracket pastes with paste-start/paste-end markers. */
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
/** Restore the terminal's default (un-bracketed) paste behaviour. */
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";

/**
 * Reassemble a pasted block. readline fires a "line" event for each newline
 * inside the paste (the `innerLines`); the final, un-terminated segment is
 * still sitting in `rl.line` at paste-end (the `tail`). Joining them with "\n"
 * reconstructs the original pasted text verbatim.
 */
export function assemblePaste(
  innerLines: readonly string[],
  tail: string,
): string {
  return [...innerLines, tail].join("\n");
}

/** One-line on-screen stand-in for a collapsed multi-line paste. */
export function pastePlaceholder(block: string): string {
  const n = block.split("\n").length;
  return `[Pasted ${n} line${n === 1 ? "" : "s"}]`;
}

/**
 * Expand every collapsed-paste placeholder in a submitted line back to its
 * real text. Handles placeholders mixed with text the user typed by hand, and
 * multiple pastes in one line.
 */
export function expandPastes(
  line: string,
  blocks: ReadonlyMap<string, string>,
): string {
  let out = line;
  for (const [placeholder, text] of blocks) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(text);
  }
  return out;
}

/**
 * Tracks the in-flight paste between paste-start and paste-end.
 *
 * `start()` opens a fresh buffer; each inner "line" event is fed to
 * `pushInner()`; `end(tail)` closes it and returns the full block plus the
 * number of inner rows the terminal echoed (needed to wipe them off-screen).
 */
export class PasteBuffer {
  private innerLines: string[] = [];
  /** True between paste-start and paste-end. */
  pasting = false;

  start(): void {
    this.pasting = true;
    this.innerLines = [];
  }

  /** Buffer an inner line (a "line" event fired during the paste). */
  pushInner(line: string): void {
    this.innerLines.push(line);
  }

  /**
   * Close the paste. `tail` is readline's current buffer (the un-terminated
   * final segment). Returns the reassembled block and how many inner rows the
   * terminal echoed above the tail.
   */
  end(tail: string): { block: string; echoedRows: number } {
    const echoedRows = this.innerLines.length;
    const block = assemblePaste(this.innerLines, tail);
    this.innerLines = [];
    this.pasting = false;
    return { block, echoedRows };
  }
}

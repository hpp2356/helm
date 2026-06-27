import { describe, it, expect } from "vitest";
import {
  assemblePaste,
  pastePlaceholder,
  expandPastes,
  PasteBuffer,
  BRACKETED_PASTE_ON,
  BRACKETED_PASTE_OFF,
} from "../src/paste.js";

describe("assemblePaste", () => {
  it("rejoins inner lines and the tail with newlines", () => {
    expect(assemblePaste(["a", "b"], "c")).toBe("a\nb\nc");
  });

  it("single-line paste (no inner lines) is just the tail", () => {
    expect(assemblePaste([], "only line")).toBe("only line");
  });

  it("preserves blank lines inside the block", () => {
    expect(assemblePaste(["a", ""], "c")).toBe("a\n\nc");
  });
});

describe("pastePlaceholder", () => {
  it("pluralises line count", () => {
    expect(pastePlaceholder("a\nb\nc")).toBe("[Pasted 3 lines]");
  });

  it("singular for one line", () => {
    expect(pastePlaceholder("just one")).toBe("[Pasted 1 line]");
  });
});

describe("expandPastes", () => {
  it("expands a lone placeholder", () => {
    const blocks = new Map([["[Pasted 2 lines]", "a\nb"]]);
    expect(expandPastes("[Pasted 2 lines]", blocks)).toBe("a\nb");
  });

  it("expands a placeholder with typed text around it", () => {
    const blocks = new Map([["[Pasted 2 lines]", "x\ny"]]);
    expect(expandPastes("fix this: [Pasted 2 lines] thanks", blocks)).toBe(
      "fix this: x\ny thanks",
    );
  });

  it("leaves lines with no placeholder untouched", () => {
    const blocks = new Map([["[Pasted 2 lines]", "x\ny"]]);
    expect(expandPastes("plain typed message", blocks)).toBe(
      "plain typed message",
    );
  });
});

describe("PasteBuffer", () => {
  it("coalesces a multi-line paste into one block (the core bug fix)", () => {
    const buf = new PasteBuffer();
    expect(buf.pasting).toBe(false);

    // Simulate: paste-start, then readline fires a 'line' event per inner
    // newline, then paste-end with the final segment still in rl.line.
    buf.start();
    expect(buf.pasting).toBe(true);
    buf.pushInner("line one");
    buf.pushInner("line two");
    const { block, echoedRows } = buf.end("line three");

    expect(block).toBe("line one\nline two\nline three");
    expect(echoedRows).toBe(2);
    expect(buf.pasting).toBe(false);
  });

  it("a single-line paste yields zero echoed rows", () => {
    const buf = new PasteBuffer();
    buf.start();
    const { block, echoedRows } = buf.end("solo");
    expect(block).toBe("solo");
    expect(echoedRows).toBe(0);
  });

  it("start() resets a previous buffer", () => {
    const buf = new PasteBuffer();
    buf.start();
    buf.pushInner("stale");
    buf.start(); // new paste — old inner lines must be dropped
    const { block } = buf.end("fresh");
    expect(block).toBe("fresh");
  });

  it("end-to-end: assemble then placeholder then expand round-trips", () => {
    const buf = new PasteBuffer();
    buf.start();
    buf.pushInner("first");
    buf.pushInner("second");
    const { block } = buf.end("third");

    const placeholder = pastePlaceholder(block);
    const blocks = new Map([[placeholder, block]]);
    // The user submits the placeholder; we expand it back to the real text.
    expect(expandPastes(placeholder, blocks)).toBe("first\nsecond\nthird");
  });
});

describe("bracketed paste escape codes", () => {
  it("enable/disable are the standard DEC private mode 2004 toggles", () => {
    expect(BRACKETED_PASTE_ON).toBe("\x1b[?2004h");
    expect(BRACKETED_PASTE_OFF).toBe("\x1b[?2004l");
  });
});

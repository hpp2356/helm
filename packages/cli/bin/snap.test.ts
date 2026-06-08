// packages/cli/bin/snap.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

describe("theme", () => {
  afterEach(() => { vi.resetModules(); });

  it("no-color mode returns plain text", async () => {
    const original = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme();
    expect(t.error("hello")).toBe("hello");
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  });

  it("truecolor mode wraps text with ANSI codes", async () => {
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("truecolor");
    expect(t.error("x")).toMatch(/\x1b\[/);
  });
});

describe("sanitize", () => {
  it("strips cursor movement sequences", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("\x1b[2Ahello")).toBe("hello");
    expect(sanitize("\x1b[Hhello")).toBe("hello");
  });

  it("strips clear screen", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("\x1b[2Jhello")).toBe("hello");
  });

  it("strips alt screen toggle", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("\x1b[?1049hhello\x1b[?1049l")).toBe("hello");
  });

  it("strips OSC title sequences", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("\x1b]0;My Title\x07hello")).toBe("hello");
  });

  it("preserves SGR color codes", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    const colored = "\x1b[32mhello\x1b[0m";
    expect(sanitize(colored)).toBe(colored);
  });

  it("preserves plain text", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("hello world\n")).toBe("hello world\n");
  });

  it("detects binary content", async () => {
    const { isBinary } = await import("../src/sanitize.js");
    expect(isBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(isBinary(Buffer.from("hello world"))).toBe(false);
  });

  it("summarizes large output", async () => {
    const { collapseOutput } = await import("../src/sanitize.js");
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const result = collapseOutput(lines.join("\n"));
    expect(result.collapsed).toBe(true);
    expect(result.summary).toContain("250");
  });
});

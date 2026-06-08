// packages/cli/bin/snap.test.ts
import { describe, it, expect, vi } from "vitest";

describe("theme", () => {
  it("no-color mode returns plain text", async () => {
    const original = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    vi.resetModules();
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

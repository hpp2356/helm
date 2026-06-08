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

  it("strips private mode sequences like cursor hide", async () => {
    const { sanitize } = await import("../src/sanitize.js");
    expect(sanitize("\x1b[?25hhello\x1b[?25l")).toBe("hello");
  });

  it("summarizes large output", async () => {
    const { collapseOutput } = await import("../src/sanitize.js");
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const result = collapseOutput(lines.join("\n"));
    expect(result.collapsed).toBe(true);
    expect(result.summary).toContain("250");
  });
});

describe("StatusBar", () => {
  it("renders full bar at >=100 cols", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderStatusBar({
      theme: t, cols: 120,
      model: "deepseek-v4-flash", mode: "interactive",
      contextPct: 30, cost: 0.003, durationMs: 12000,
      currentTool: "read_file", bgTasks: 2,
    });
    expect(result).toContain("deepseek-v4-flash");
    expect(result).toContain("30%");
    expect(result).toContain("read_file");
    expect(result).toContain("2bg");
  });

  it("hides tool and bg at <80 cols", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderStatusBar({
      theme: t, cols: 65,
      model: "deepseek-v4-flash", mode: "interactive",
      contextPct: 30, cost: null, durationMs: 5000,
      currentTool: null, bgTasks: 0,
    });
    expect(result).not.toContain("read_file");
    expect(result).toContain("30%");
  });

  it("shows auto-approve warning", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderStatusBar({
      theme: t, cols: 100,
      model: "ds", mode: "auto-approve",
      contextPct: 50, cost: null, durationMs: 0,
      currentTool: null, bgTasks: 0,
    });
    expect(result).toContain("⚠");
    expect(result).toContain("auto-approve");
  });
});

describe("TurnStateMachine", () => {
  it("starts idle", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    expect(sm.state).toBe("idle");
  });

  it("transitions idle → sending → running → completed → idle", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    sm.send("sending"); expect(sm.state).toBe("sending");
    sm.send("running"); expect(sm.state).toBe("running");
    sm.send("completed"); expect(sm.state).toBe("completed");
    sm.send("idle"); expect(sm.state).toBe("idle");
  });

  it("rejects invalid transitions", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    expect(() => sm.send("running")).toThrow();
  });

  it("notifies listeners on state change", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    const events: string[] = [];
    sm.on("change", (s) => events.push(s));
    sm.send("sending");
    sm.send("running");
    expect(events).toEqual(["sending", "running"]);
  });

  it("queued replaces previous pending input", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    sm.send("sending");
    sm.enqueue("first");
    sm.enqueue("second");
    expect(sm.pendingInput).toBe("second");
  });

  it("enqueue from idle transitions to queued", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    sm.enqueue("hello");
    expect(sm.state).toBe("queued");
    expect(sm.pendingInput).toBe("hello");
  });

  it("dequeue returns and clears pending input", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    sm.enqueue("hello");
    expect(sm.dequeue()).toBe("hello");
    expect(sm.pendingInput).toBeNull();
  });

  it("off removes listener", async () => {
    const { TurnStateMachine } = await import("../src/state-machine.js");
    const sm = new TurnStateMachine();
    const events: string[] = [];
    const listener = (s: string) => events.push(s);
    sm.on("change", listener);
    sm.send("sending");
    sm.off("change", listener);
    sm.send("running");
    expect(events).toEqual(["sending"]); // not "running"
  });
});

describe("transcript cards", () => {
  it("renders user card", async () => {
    const { renderUserCard } = await import("../src/transcript.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderUserCard("hello world", t);
    expect(result).toContain("▸");
    expect(result).toContain("hello world");
  });

  it("renders assistant card with timing", async () => {
    const { renderAssistantCard } = await import("../src/transcript.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderAssistantCard("reply text", 3200, "Cooked", t);
    expect(result).toContain("●");
    expect(result).toContain("reply text");
    expect(result).toContain("Cooked for 3s");
  });

  it("renders collapsed tool card", async () => {
    const { renderToolCard } = await import("../src/transcript.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderToolCard({ name: "read_file", target: "src/foo.ts", success: true, durationMs: 120, lineCount: 42 }, t);
    expect(result).toContain("⚙");
    expect(result).toContain("read_file");
    expect(result).toContain("✓");
    expect(result).toContain("42");
  });

  it("renders error card", async () => {
    const { renderErrorCard } = await import("../src/transcript.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderErrorCard("connection refused", t);
    expect(result).toContain("✗");
    expect(result).toContain("connection refused");
  });

  it("renders system notice", async () => {
    const { renderSystemNotice } = await import("../src/transcript.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const result = renderSystemNotice("Compaction: 42 msgs → 8 msgs", t);
    expect(result).toContain("ℹ");
  });
});

describe("status bar width breakpoints snapshots", () => {
  it("60 cols: shows only model/ctx/dur, no mode", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const r = renderStatusBar({ theme: t, cols: 60, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    expect(r).not.toContain("interactive");
    expect(r).toContain("10%");
  });

  it("80 cols: shows model/mode/ctx/dur", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const r = renderStatusBar({ theme: t, cols: 80, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    expect(r).toContain("interactive");
    expect(r).toContain("10%");
  });

  it("100 cols: shows cost field", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const r = renderStatusBar({ theme: t, cols: 100, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    expect(r).toContain("n/a");
  });

  it("120 cols: shows tool and bg tasks", async () => {
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const r = renderStatusBar({ theme: t, cols: 120, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: "bash", bgTasks: 3 });
    expect(r).toContain("bash");
    expect(r).toContain("3bg");
  });
});

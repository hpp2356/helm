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

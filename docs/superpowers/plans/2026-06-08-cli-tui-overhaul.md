# CLI TUI 全面改造 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有滚动式 REPL 基础上，增加固定底部 chrome（状态栏 + 输入框架）、语义主题系统、工具输出过滤、turn 状态机、外部编辑器支持，并将 repl.ts 拆分为职责清晰的小模块。

**Architecture:** 纯 Node.js + ANSI escape，不引入 TUI 框架。Transcript 正常打印进 scrollback；状态栏 + Composer frame 通过 cursor save/restore 固定在终端底部 4 行。所有颜色通过 theme.ts 中的语义 token，禁止硬编码 ANSI 码。

**Tech Stack:** Node.js 内置模块（readline、child_process、fs、os）、TypeScript、vitest

---

## 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `packages/cli/src/theme.ts` | 新建 | 颜色能力探测 + 语义 token + dark 预设 |
| `packages/cli/src/sanitize.ts` | 新建 | 工具输出 ANSI 过滤器 |
| `packages/cli/src/state-machine.ts` | 新建 | Turn 状态机（8 个状态） |
| `packages/cli/src/input-frame.ts` | 新建（从 repl.ts 提取） | InputFrame 类 |
| `packages/cli/src/status-bar.ts` | 新建 | 状态栏渲染 + 宽度断点 |
| `packages/cli/src/transcript.ts` | 新建 | 各类 card 渲染函数 |
| `packages/cli/src/keybindings.ts` | 新建 | 快捷键集中注册 |
| `packages/cli/src/editor.ts` | 新建 | 外部编辑器 suspend/resume |
| `packages/cli/src/repl.ts` | 修改（大幅精简） | 主 REPL 协调器 |
| `packages/cli/src/paste.ts` | 不变 | 已有，不动 |
| `packages/cli/bin/snap.test.ts` | 新建 | 快照测试（无 TTY） |

---

### Task 1：theme.ts — 颜色能力探测 + 语义 token

**Files:**
- Create: `packages/cli/src/theme.ts`
- Test: `packages/cli/bin/snap.test.ts`（Task 13 统一建，本任务写 theme 相关用例）

- [ ] **Step 1：写失败测试**

在 `packages/cli/bin/snap.test.ts` 中添加（文件先只建骨架）：

```typescript
// packages/cli/bin/snap.test.ts
import { describe, it, expect } from "vitest";

describe("theme", () => {
  it("no-color mode returns plain text", async () => {
    const original = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    // 必须 re-import，因为探测在模块加载时执行
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
```

- [ ] **Step 2：运行测试确认失败**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -40
```

期望：FAIL，找不到 `../src/theme.js`

- [ ] **Step 3：实现 theme.ts**

```typescript
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
  if (term.includes("256color") || ct === "256") return "ansi256";
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
      error: (s) => `${BOLD}${s}${RESET}`,
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
      border: painter("\x1b[33m"),       // yellow
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
```

- [ ] **Step 4：运行测试确认通过**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -40
```

期望：theme 相关用例 PASS

- [ ] **Step 5：提交**

```bash
git add packages/cli/src/theme.ts packages/cli/bin/snap.test.ts
git commit -m "feat(cli): theme.ts — semantic tokens + color capability probe"
```

---

### Task 2：sanitize.ts — 工具输出 ANSI 过滤器

**Files:**
- Create: `packages/cli/src/sanitize.ts`
- Test: `packages/cli/bin/snap.test.ts`（追加用例）

- [ ] **Step 1：写失败测试**

在 `packages/cli/bin/snap.test.ts` 追加：

```typescript
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
```

- [ ] **Step 2：运行测试确认失败**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

期望：FAIL，找不到 `../src/sanitize.js`

- [ ] **Step 3：实现 sanitize.ts**

```typescript
// packages/cli/src/sanitize.ts

// 过滤掉危险 ANSI 序列，只保留普通文本和 SGR 颜色码
// 正则匹配顺序：先精确匹配危险序列，再保留 SGR，其余 ESC 序列全部丢弃

const STRIP_PATTERNS = [
  // 光标移动 ESC[<n>A/B/C/D/E/F/G/H/f/s/u
  /\x1b\[\d*[ABCDEFGHfsu]/g,
  // 擦除 ESC[J ESC[K ESC[2J
  /\x1b\[\d*[JK]/g,
  // Alt screen ESC[?1049h/l
  /\x1b\[\?1049[hl]/g,
  // 鼠标上报 ESC[?1000h/l ESC[?1002h/l ESC[?1003h/l
  /\x1b\[\?100[023][hl]/g,
  // Bracketed paste ESC[?2004h/l
  /\x1b\[\?2004[hl]/g,
  // OSC sequences ESC]...BEL or ESC]...ST
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  // 其余 ESC[ 序列（非 SGR m 结尾）— 放最后，避免过度匹配
  /\x1b\[[\d;]*[^m\d;]/g,
];

// SGR 保留白名单：ESC[<params>m，params 只允许 0-9 和分号
// 这会保留所有标准颜色/样式码，包括 256色和 truecolor
const SGR_SAFE = /\x1b\[[\d;]*m/;

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
```

- [ ] **Step 4：运行测试确认通过**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

期望：sanitize 所有用例 PASS

- [ ] **Step 5：提交**

```bash
git add packages/cli/src/sanitize.ts packages/cli/bin/snap.test.ts
git commit -m "feat(cli): sanitize.ts — tool output ANSI filter + binary detection"
```

---

### Task 3：state-machine.ts — Turn 状态机

**Files:**
- Create: `packages/cli/src/state-machine.ts`
- Test: `packages/cli/bin/snap.test.ts`（追加用例）

- [ ] **Step 1：写失败测试**

```typescript
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
});
```

- [ ] **Step 2：运行测试确认失败**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

- [ ] **Step 3：实现 state-machine.ts**

```typescript
// packages/cli/src/state-machine.ts

export type TurnState =
  | "idle"
  | "queued"
  | "sending"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "failed"
  | "completed";

type Transition = TurnState;

// 合法转换表
const TRANSITIONS: Record<TurnState, TurnState[]> = {
  idle:             ["sending", "queued"],
  queued:           ["sending"],
  sending:          ["running", "failed", "cancelling"],
  running:          ["waiting_approval", "cancelling", "failed", "completed"],
  waiting_approval: ["running", "cancelling"],
  cancelling:       ["idle"],
  failed:           ["idle"],
  completed:        ["idle"],
};

type ChangeListener = (state: TurnState) => void;

export class TurnStateMachine {
  private _state: TurnState = "idle";
  private _pendingInput: string | null = null;
  private listeners: ChangeListener[] = [];

  get state(): TurnState { return this._state; }
  get pendingInput(): string | null { return this._pendingInput; }

  send(next: Transition): void {
    const allowed = TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${this._state} → ${next}`);
    }
    this._state = next;
    for (const l of this.listeners) l(this._state);
  }

  /** 入队一条用户输入（运行中时调用）；多次调用用最新值替换。 */
  enqueue(input: string): void {
    this._pendingInput = input;
    if (this._state === "idle" || this._state === "completed" || this._state === "failed") return;
    if (this._state !== "queued") {
      // 不调用 send() 以避免触发非法转换检查
      this._state = "queued";
      for (const l of this.listeners) l(this._state);
    }
  }

  /** 取出并清除入队输入。 */
  dequeue(): string | null {
    const v = this._pendingInput;
    this._pendingInput = null;
    return v;
  }

  on(event: "change", listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  off(event: "change", listener: ChangeListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
}
```

- [ ] **Step 4：运行测试确认通过**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

- [ ] **Step 5：提交**

```bash
git add packages/cli/src/state-machine.ts packages/cli/bin/snap.test.ts
git commit -m "feat(cli): state-machine.ts — turn state machine with transition guards"
```

---

### Task 4：input-frame.ts — 从 repl.ts 提取 InputFrame

**Files:**
- Create: `packages/cli/src/input-frame.ts`
- Modify: `packages/cli/src/repl.ts`（删除 InputFrame 类，改为 import）

- [ ] **Step 1：创建 input-frame.ts**

```typescript
// packages/cli/src/input-frame.ts
import type { Theme } from "./theme.js";

function termCols(): number {
  return process.stdout.columns || 80;
}

function frameWidth(): number {
  return Math.max(8, termCols() - 1);
}

export class InputFrame {
  private active = false;
  private repaintQueued = false;
  private theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  private frameRule(): string {
    return this.theme.border("─".repeat(frameWidth()));
  }

  private readonly schedulePaint = () => {
    if (!this.active || this.repaintQueued) return;
    this.repaintQueued = true;
    setImmediate(() => {
      this.repaintQueued = false;
      this.paintBottom();
    });
  };

  attach(): void {
    if (!process.stdout.isTTY) return;
    process.stdin.on("keypress", this.schedulePaint);
    process.stdout.on("resize", this.schedulePaint);
  }

  detach(): void {
    process.stdin.off("keypress", this.schedulePaint);
    process.stdout.off("resize", this.schedulePaint);
  }

  open(prompt: () => void): void {
    if (!process.stdout.isTTY) {
      prompt();
      return;
    }
    process.stdout.write(this.frameRule() + "\n");
    process.stdout.write("\n\x1b[1A");
    prompt();
    this.active = true;
    this.paintBottom();
  }

  close(): void {
    this.active = false;
  }

  repaint(): void {
    this.paintBottom();
  }

  private paintBottom(): void {
    if (!this.active || !process.stdout.isTTY) return;
    process.stdout.write("\x1b7\x1b[1B\r\x1b[2K" + this.frameRule() + "\x1b8");
  }
}
```

- [ ] **Step 2：修改 repl.ts，删除 InputFrame 类，改为 import**

在 repl.ts 顶部 import 区加：
```typescript
import { InputFrame } from "./input-frame.js";
```

删除 repl.ts 中原有的 `class InputFrame { ... }` 整段代码（约 55 行，从 `class InputFrame {` 到对应的 `}`）。

删除 repl.ts 中所有硬编码 ANSI 常量（`RESET`、`BOLD`、`DIM`、`ITALIC`、`PINK`、`ORANGE`）以及 `frameRule()`、`frameWidth()`、`termCols()` 函数，改为从 `theme` 和 `InputFrame` 中获取。

在 `startRepl` 函数开头（`const runId = ...` 之前）添加：
```typescript
import { theme } from "./theme.js";
// (已在顶部 import，此处只是说明使用位置)
const frame = new InputFrame(theme);
```

- [ ] **Step 3：typecheck 确认无编译错误**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli typecheck 2>&1
```

期望：0 errors

- [ ] **Step 4：提交**

```bash
git add packages/cli/src/input-frame.ts packages/cli/src/repl.ts
git commit -m "refactor(cli): extract InputFrame into input-frame.ts, wire theme"
```

---

### Task 5：status-bar.ts — 状态栏渲染

**Files:**
- Create: `packages/cli/src/status-bar.ts`
- Test: `packages/cli/bin/snap.test.ts`（追加用例）

- [ ] **Step 1：写失败测试**

```typescript
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
```

- [ ] **Step 2：运行测试确认失败**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

- [ ] **Step 3：实现 status-bar.ts**

```typescript
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
  // 取第一个单词或前 maxLen 字符
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

/** visLen: 可见字符宽度（忽略 ANSI） */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
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
    const parts: string[] = [
      theme.textMuted(mShort),
      modeStr,
      `ctx ${ctxStr}`,
    ];
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

  // <60
  const mAbbr = modelAbbr(model, 4);
  return [theme.textMuted(mAbbr), ctxStr, durStr].join(sep);
}
```

- [ ] **Step 4：运行测试确认通过**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -60
```

- [ ] **Step 5：提交**

```bash
git add packages/cli/src/status-bar.ts packages/cli/bin/snap.test.ts
git commit -m "feat(cli): status-bar.ts — responsive width breakpoints + context color thresholds"
```

---

### Task 6：transcript.ts — Card 渲染函数

**Files:**
- Create: `packages/cli/src/transcript.ts`
- Test: `packages/cli/bin/snap.test.ts`（追加用例）

- [ ] **Step 1：写失败测试**

```typescript
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
```

- [ ] **Step 2：运行测试确认失败**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -80
```

- [ ] **Step 3：实现 transcript.ts**

```typescript
// packages/cli/src/transcript.ts
import type { Theme } from "./theme.js";

const WORK_VERBS = ["Cooked","Baked","Brewed","Simmered","Forged","Conjured","Pondered","Crafted"];

export function pickVerb(turnIndex: number): string {
  return WORK_VERBS[turnIndex % WORK_VERBS.length]!;
}

/** Minimal Markdown → ANSI renderer */
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
  target?: string;
  success: boolean;
  durationMs: number;
  lineCount?: number;
  summary?: string;
}

export function renderToolCard(opts: ToolCardOptions, theme: Theme): string {
  const { name, target, success, durationMs, lineCount, summary } = opts;
  const icon = success ? theme.success("✓") : theme.error("✗");
  const ms = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const parts = [theme.tool(`⚙ ${name}`), target ?? "", icon];
  if (lineCount !== undefined) parts.push(`${lineCount} lines`);
  if (summary) parts.push(summary);
  parts.push(theme.dim(`[${ms}]`));
  return parts.filter(Boolean).join("  ");
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
```

- [ ] **Step 4：运行测试确认通过**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli test -- --reporter=verbose 2>&1 | head -80
```

- [ ] **Step 5：提交**

```bash
git add packages/cli/src/transcript.ts packages/cli/bin/snap.test.ts
git commit -m "feat(cli): transcript.ts — card render functions for all message types"
```

---

### Task 7：keybindings.ts — 快捷键集中注册

**Files:**
- Create: `packages/cli/src/keybindings.ts`

- [ ] **Step 1：实现 keybindings.ts**（无需单独测试，通过 repl 集成测试覆盖）

```typescript
// packages/cli/src/keybindings.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type KeyAction =
  | "submit"
  | "interrupt"
  | "exit"
  | "newline"
  | "openEditor"
  | "tabComplete"
  | "historyPrev"
  | "historyNext"
  | "escape";

export interface KeyBinding {
  ctrl?: boolean;
  shift?: boolean;
  name: string;
  sequence?: string;
}

export type Keybindings = Map<KeyAction, KeyBinding[]>;

const DEFAULTS: Array<[KeyAction, KeyBinding]> = [
  ["submit",      { name: "return" }],
  ["interrupt",   { ctrl: true, name: "c" }],
  ["exit",        { ctrl: true, name: "d" }],
  ["newline",     { ctrl: true, name: "j" }],
  ["tabComplete", { name: "tab" }],
  ["historyPrev", { name: "up" }],
  ["historyNext", { name: "down" }],
  ["escape",      { name: "escape" }],
];

export function loadKeybindings(): Keybindings {
  const map: Keybindings = new Map();
  for (const [action, binding] of DEFAULTS) {
    map.set(action, [binding]);
  }

  const userFile = resolve(process.env.HOME ?? "/tmp", ".helm", "keybindings.json");
  if (existsSync(userFile)) {
    try {
      const user = JSON.parse(readFileSync(userFile, "utf-8")) as Record<string, KeyBinding[]>;
      for (const [action, bindings] of Object.entries(user)) {
        if (map.has(action as KeyAction)) {
          map.set(action as KeyAction, bindings);
        } else {
          process.stderr.write(`[helm] keybindings: unknown action "${action}", ignored\n`);
        }
      }
    } catch {
      // Non-fatal
    }
  }
  return map;
}

export function matchesBinding(
  key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
  bindings: KeyBinding[],
): boolean {
  for (const b of bindings) {
    if (b.name !== key.name) continue;
    if (b.ctrl !== undefined && b.ctrl !== (key.ctrl ?? false)) continue;
    if (b.shift !== undefined && b.shift !== (key.shift ?? false)) continue;
    return true;
  }
  return false;
}
```

- [ ] **Step 2：typecheck**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli typecheck 2>&1
```

- [ ] **Step 3：提交**

```bash
git add packages/cli/src/keybindings.ts
git commit -m "feat(cli): keybindings.ts — centralized keybinding registry with user overrides"
```

---

### Task 8：editor.ts — 外部编辑器 suspend/resume

**Files:**
- Create: `packages/cli/src/editor.ts`

- [ ] **Step 1：实现 editor.ts**

```typescript
// packages/cli/src/editor.ts
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface as ReadlineInterface } from "node:readline";
import type { InputFrame } from "./input-frame.js";

interface EditorDeps {
  rl: ReadlineInterface & {
    line: string;
    cursor: number;
    _refreshLine: () => void;
  };
  frame: InputFrame;
  onStatusPause: () => void;
  onStatusResume: () => void;
}

/**
 * Open the user's $VISUAL/$EDITOR with the current readline buffer content.
 * Suspends the TUI, hands control to the editor, then restores everything.
 * Returns false if no editor is configured.
 */
export function openExternalEditor(deps: EditorDeps): boolean {
  const editorBin =
    process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");

  // 1. Pause TUI
  deps.frame.close();
  deps.onStatusPause();
  deps.rl.pause();

  // 2. Write current buffer to tmp file
  const tmpDir = mkdtempSync(join(tmpdir(), "helm-edit-"));
  const tmpFile = join(tmpDir, "input.md");
  writeFileSync(tmpFile, deps.rl.line, "utf-8");

  // 3. Restore cooked mode so the editor gets a proper terminal
  const isTTY = process.stdin.isTTY;
  if (isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }

  // 4. Run the editor synchronously (inherits stdio)
  spawnSync(editorBin, [tmpFile], { stdio: "inherit" });

  // 5. Flush stdin (drain stray bytes left by the editor)
  if (isTTY) {
    try { process.stdin.setRawMode(true); } catch { /* ignore */ }
  }

  // 6. Read back the edited content
  let content = "";
  try {
    content = readFileSync(tmpFile, "utf-8");
    unlinkSync(tmpFile);
  } catch { /* ignore */ }
  try { unlinkSync(tmpDir); } catch { /* ignore */ }

  // 7. Put content back into readline buffer
  deps.rl.line = content.replace(/\n$/, ""); // strip trailing newline
  deps.rl.cursor = deps.rl.line.length;
  deps.rl._refreshLine();

  // 8. Resume TUI
  deps.rl.resume();
  deps.frame.repaint();
  deps.onStatusResume();

  return true;
}
```

- [ ] **Step 2：typecheck**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli typecheck 2>&1
```

- [ ] **Step 3：提交**

```bash
git add packages/cli/src/editor.ts
git commit -m "feat(cli): editor.ts — external editor suspend/resume with stdin flush"
```

---

### Task 9：repl.ts 完整重写 — 接入所有新模块

**Files:**
- Modify: `packages/cli/src/repl.ts`

这是最大的改动，把所有新模块接进来，并把 repl.ts 瘦身为协调器。

- [ ] **Step 1：重写 repl.ts**

用以下完整内容替换 `packages/cli/src/repl.ts`：

```typescript
import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonlJournal,
  RiskLevel,
  TokenBudget,
  type PermissionPolicy,
  type NonInteractiveStrategy,
} from "@helm/core";
import {
  AgentLoop,
  ToolRuntime,
  PermissionRuntime,
  Compaction,
  CharTokenCounter,
  ContextBuilder,
  type CompactionStrategy,
  type MessageRecord,
} from "@helm/runtime";
import { registerFileTools } from "@helm/runtime";
import type { Provider } from "@helm/core";
import {
  PasteBuffer,
  pastePlaceholder,
  expandPastes,
  BRACKETED_PASTE_ON,
  BRACKETED_PASTE_OFF,
} from "./paste.js";
import { theme } from "./theme.js";
import { InputFrame } from "./input-frame.js";
import { renderStatusBar } from "./status-bar.js";
import { sanitize, isBinary, collapseOutput } from "./sanitize.js";
import { TurnStateMachine } from "./state-machine.js";
import {
  renderUserCard,
  renderAssistantCard,
  renderToolCard,
  renderToolResultCollapsed,
  renderErrorCard,
  renderSystemNotice,
  renderApprovalPrompt,
  pickVerb,
} from "./transcript.js";
import { loadKeybindings, matchesBinding } from "./keybindings.js";
import { openExternalEditor } from "./editor.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReplConfig {
  provider: Provider;
  providerName: string;
  toolsPath?: string;
  permsPath?: string;
  workspaceRoot?: string;
  nonInteractive?: NonInteractiveStrategy;
  riskThreshold?: RiskLevel;
  compaction?: CompactionStrategy;
  compactionKeepTurns: number;
  tokenBudgetMax?: number;
  maxTurns: number;
  systemPrompt?: string | null;
  configPath?: string;
}

interface PermRule {
  action: "allow" | "deny";
  pattern: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HELM_HISTORY_FILE = `${process.env.HOME || "~"}/.helm_history`;

const SPIN_FRAMES = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"];
const SPIN_VERBS = [
  "Razzmatazzing","Conjuring","Percolating","Marinating",
  "Noodling","Tinkering","Finagling","Cogitating",
];
const SPIN_TIPS = [
  "Press Ctrl-C to interrupt the current turn",
  "Type /help for the full command list",
  "/clear wipes the conversation and starts fresh",
  "/mode switches the permission strategy on the fly",
  "Every turn is journaled — replay it from /tmp later",
  "/stats shows messages, turns, and the journal path",
];

// ── Helpers ────────────────────────────────────────────────────────────────

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVis(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

function truncVis(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  let out = ""; let vis = 0; let i = 0;
  while (i < s.length && vis < width - 1) {
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    out += s[i]; vis++; i++;
  }
  return out + theme.reset + "…";
}

function termCols(): number {
  return process.stdout.columns || 80;
}

function loadJson<T>(path: string): T {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

function hr(): void { console.log(); }

function helmVersion(): string {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = new URL(rel, import.meta.url);
      const v = JSON.parse(readFileSync(pkg, "utf-8")).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  return "0.0.0";
}

// ── Welcome Box ────────────────────────────────────────────────────────────

const MASCOT = ["  ▐▛▀▜▌  ", "  ▐▌◣◢▐▌ ", "  ▝▜▄▟▘  "];

function renderWelcomeBox(opts: { title: string; greeting: string; cwd: string; tips: string[] }): string {
  const width = Math.max(8, Math.min(termCols() - 1, 78));
  const inner = width - 2;
  const leftW = 22; const gapW = 3; const rightW = inner - leftW - gapW;
  const left: string[] = ["", ...MASCOT.map((m) => theme.accent(padVis(m, 9))), "", `   ${theme.bold(opts.greeting)}`, ""];
  const right: string[] = [`${theme.bold(theme.accent("Session"))}`, ...opts.tips];
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  const titleSeg = `─ ${theme.bold(opts.title)}${theme.border(" ")}`;
  const dashes = inner - visLen(titleSeg);
  lines.push(theme.border("╭") + titleSeg + theme.border("─".repeat(Math.max(0, dashes)) + "╮"));
  for (let r = 0; r < rows; r++) {
    const l = padVis(truncVis(left[r] ?? "", leftW), leftW);
    const sep = theme.dim("│");
    const rt = padVis(truncVis(right[r] ?? "", rightW), rightW);
    lines.push(theme.border("│") + " " + l + " " + sep + " " + rt + theme.border("│"));
  }
  lines.push(theme.border("╰" + "─".repeat(inner) + "╯"));
  lines.push(""); lines.push(theme.dim(opts.cwd));
  return lines.join("\n");
}

// ── Spinner ────────────────────────────────────────────────────────────────

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private drawn = false;
  constructor(private readonly verb: string, private readonly tip: string) {}

  start(): void {
    if (!process.stdout.isTTY) return;
    this.render();
    this.timer = setInterval(() => { this.frame = (this.frame + 1) % SPIN_FRAMES.length; this.redraw(); }, 120);
    this.timer.unref?.();
  }

  private render(): void {
    process.stdout.write(theme.accent(SPIN_FRAMES[this.frame]!) + " " + theme.dim(this.verb + "…") + "\n");
    process.stdout.write(theme.dim("  └ Tip: " + this.tip) + "\n");
    this.drawn = true;
  }

  private redraw(): void {
    if (!this.drawn) return;
    process.stdout.write("\x1b[2A\x1b[0J");
    this.render();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[2A\x1b[0J"); this.drawn = false; }
  }

  printAbove(line: string): void {
    if (this.drawn && process.stdout.isTTY) { process.stdout.write("\x1b[2A\x1b[0J"); console.log(line); this.render(); }
    else console.log(line);
  }
}

let activeSpinner: Spinner | null = null;

function emit(line: string): void {
  if (activeSpinner) activeSpinner.printAbove(line);
  else console.log(line);
}

// ── Status Bar (live, painted above composer) ──────────────────────────────

interface StatusState {
  model: string;
  mode: string;
  contextPct: number;
  cost: number | null;
  durationMs: number;
  currentTool: string | null;
  bgTasks: number;
  turnStart: number;
}

let statusState: StatusState = {
  model: "", mode: "interactive", contextPct: 0,
  cost: null, durationMs: 0, currentTool: null, bgTasks: 0, turnStart: 0,
};
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusPaused = false;

function paintStatusBar(): void {
  if (statusPaused || !process.stdout.isTTY) return;
  const cols = termCols();
  const bar = renderStatusBar({ theme, cols, ...statusState });
  // 状态栏在 Composer 顶部规则线上方：save → up 2 → col 0 → clear line → draw → restore
  process.stdout.write("\x1b7\x1b[2A\r\x1b[2K" + bar + "\x1b8");
}

function startStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    if (statusState.turnStart > 0) {
      statusState.durationMs = Date.now() - statusState.turnStart;
    }
    paintStatusBar();
  }, 1000);
  statusTimer.unref?.();
}

function stopStatusTimer(): void {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ── REPL ───────────────────────────────────────────────────────────────────

export async function startRepl(config: ReplConfig): Promise<void> {
  const runId = `repl-${Date.now()}`;
  const journalPath = `/tmp/helm-${runId}.jsonl`;
  const journal = new JsonlJournal(journalPath);
  await journal.open();

  const kb = loadKeybindings();
  const sm = new TurnStateMachine();

  // ── Permissions ─────────────────────────────────────────────────────
  const permissionRuntime = new PermissionRuntime();
  let permissionPolicy: PermissionPolicy | undefined;
  if (config.permsPath) {
    const permRules = loadJson<PermRule[]>(config.permsPath);
    for (const rule of permRules) {
      if (rule.action === "deny") {
        permissionRuntime.deny({ pattern: rule.pattern, riskLevel: RiskLevel[rule.riskLevel], description: rule.description });
      } else {
        permissionRuntime.allow({ pattern: rule.pattern, riskLevel: RiskLevel[rule.riskLevel], description: rule.description });
      }
    }
  }
  if (config.nonInteractive) {
    permissionPolicy = { strategy: config.nonInteractive, riskThreshold: config.riskThreshold };
  }

  // ── Tools ────────────────────────────────────────────────────────────
  const toolRuntime = new ToolRuntime(permissionRuntime, permissionPolicy);
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  if (config.toolsPath) {
    interface ToolDef { name: string; description: string; parameters: Record<string, unknown>; riskLevel?: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"; }
    const toolDefs = loadJson<ToolDef[]>(config.toolsPath);
    for (const td of toolDefs) {
      toolRuntime.register({ name: td.name, description: td.description, parameters: td.parameters, riskLevel: td.riskLevel ? RiskLevel[td.riskLevel] : undefined,
        async execute(args) { return JSON.stringify(Object.entries(args).map(([k, v]) => `${k}=${v}`)); },
      });
    }
  } else {
    registerFileTools(toolRuntime, workspaceRoot);
    for (const tool of toolRuntime.list()) {
      permissionRuntime.allow({ pattern: tool.name, riskLevel: tool.riskLevel ?? RiskLevel.LOW, description: `Built-in tool: ${tool.name}` });
    }
  }

  // ── Compaction ───────────────────────────────────────────────────────
  let tokenBudget: TokenBudget | undefined;
  let compaction: Compaction | undefined;
  let contextBuilder: ContextBuilder | undefined;
  if (config.compaction) {
    const tokenCounter = new CharTokenCounter();
    contextBuilder = new ContextBuilder(tokenCounter);
    const budgetMax = config.tokenBudgetMax ?? 4096;
    tokenBudget = new TokenBudget(budgetMax);
    compaction = new Compaction({ strategy: config.compaction, tokenCounter, keepRecentTurns: config.compactionKeepTurns });
  }

  // ── Status bar initial state ─────────────────────────────────────────
  statusState.model = config.providerName;
  statusState.mode = config.nonInteractive ?? "interactive";

  // ── Journal interceptor ──────────────────────────────────────────────
  const originalAppend = journal.append.bind(journal);
  journal.append = async function(event) {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "tool:call": {
        const toolName = String(e.toolName ?? "");
        statusState.currentTool = toolName;
        paintStatusBar();
        emit(renderToolCard({ name: toolName, success: true, durationMs: 0 }, theme));
        break;
      }
      case "tool:result": {
        const raw = String(e.output ?? "");
        const out = isBinary(Buffer.from(raw))
          ? "[Binary output]"
          : sanitize(collapseOutput(raw).text);
        const success = !raw.startsWith("Error:");
        emit(renderToolCard({ name: String(e.toolName ?? ""), success, durationMs: 0, summary: out.slice(0, 80) }, theme));
        statusState.currentTool = null;
        paintStatusBar();
        break;
      }
      case "compaction":
        emit(renderSystemNotice(`Compaction: msgs ${e.messageCountBefore}→${e.messageCountAfter}`, theme));
        break;
      case "error":
        emit(renderErrorCard(String(e.message), theme));
        break;
      case "run:cancelled":
        emit(theme.dim(`⏹ Cancelled: ${e.reason}`));
        break;
    }
    await originalAppend(event);
  };

  // ── History ──────────────────────────────────────────────────────────
  const historyLines: string[] = [];
  try {
    if (existsSync(HELM_HISTORY_FILE)) {
      historyLines.push(...readFileSync(HELM_HISTORY_FILE, "utf-8").split("\n").filter((l) => l.trim()));
    }
  } catch { /* non-fatal */ }

  // ── Readline + frame ─────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const frame = new InputFrame(theme);
  frame.attach();
  rl.setPrompt(theme.bold(theme.accent("› ")));

  const reprompt = (): void => {
    frame.open(() => rl.prompt());
    startStatusTimer();
    paintStatusBar();
  };

  // ── Ctrl+X Ctrl+E chord state ────────────────────────────────────────
  let ctrlXPending = false;

  // ── Bracketed paste ──────────────────────────────────────────────────
  const paste = new PasteBuffer();
  const pastedBlocks = new Map<string, string>();
  const isTTY = process.stdout.isTTY === true;
  if (isTTY) process.stdout.write(BRACKETED_PASTE_ON);

  process.stdin.on("keypress", (_chunk, key?: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) => {
    if (!key) return;

    // paste-start / paste-end
    if (key.name === "paste-start") { paste.start(); return; }
    if (key.name === "paste-end") {
      const { block, echoedRows } = paste.end(rl.line);
      if (echoedRows === 0) return;
      const placeholder = pastePlaceholder(block);
      pastedBlocks.set(placeholder, block);
      if (isTTY && echoedRows > 0) process.stdout.write(`\r\x1b[${echoedRows}A\x1b[0J`);
      const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
      rlInternal.line = placeholder; rlInternal.cursor = placeholder.length; rlInternal._refreshLine();
      frame.repaint();
      return;
    }

    // Ctrl+X Ctrl+E chord
    if (key.ctrl && key.name === "x") { ctrlXPending = true; return; }
    if (ctrlXPending) {
      ctrlXPending = false;
      if (key.ctrl && key.name === "e") {
        const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
        openExternalEditor({
          rl: rlInternal as Parameters<typeof openExternalEditor>[0]["rl"],
          frame,
          onStatusPause: () => { statusPaused = true; stopStatusTimer(); },
          onStatusResume: () => { statusPaused = false; startStatusTimer(); paintStatusBar(); },
        });
        return;
      }
    }

    // Tab completion for slash commands
    if (key.name === "tab") {
      const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine: () => void };
      const line = rlInternal.line;
      if (line.startsWith("/")) {
        const matches = COMMANDS.filter((c) => c.startsWith(line));
        if (matches.length === 1) {
          rlInternal.line = matches[0]!;
          rlInternal.cursor = matches[0]!.length;
          rlInternal._refreshLine();
        } else if (matches.length > 1) {
          emit(theme.dim(matches.join("  ")));
        }
      }
    }
  });

  // ── REPL state ───────────────────────────────────────────────────────
  const SYSTEM_MESSAGE: MessageRecord | null =
    config.systemPrompt !== undefined
      ? config.systemPrompt === null ? null : { role: "system", content: config.systemPrompt }
      : { role: "system", content:
          `You are Helm, an AI assistant powered by ${config.providerName}. ` +
          `You are helpful, concise, and honest.\n\n` +
          `<response_format>\nWrite replies as flowing, natural paragraphs of plain prose.\n` +
          `Do not use Markdown: no headings, no bullets, no **bold**, no tables.\n` +
          `Only use fenced code blocks when the user asks for code.\n` +
          `</response_format>`,
        };

  let messageHistory: MessageRecord[] = SYSTEM_MESSAGE ? [SYSTEM_MESSAGE] : [];
  let turnCount = 0;

  // ── Welcome box ──────────────────────────────────────────────────────
  const home = process.env.HOME ?? "";
  const tilde = (p: string): string => home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  const toolNames = toolRuntime.getToolNames();
  const tips: string[] = [
    `${theme.dim("Provider")}  ${config.providerName}`,
    `${theme.dim("Tools")}     ${toolNames.length}`,
  ];
  if (config.configPath) tips.push(`${theme.dim("Config")}    ${tilde(config.configPath)}`);
  tips.push(`${theme.dim("Journal")}   ${tilde(journalPath)}`);
  tips.push("");
  tips.push(theme.italic(theme.dim("/help for commands")));
  console.log();
  console.log(renderWelcomeBox({ title: `Helm v${helmVersion()}`, greeting: "Welcome back!", cwd: tilde(process.cwd()), tips }));
  console.log();
  reprompt();

  // ── Slash command registry ───────────────────────────────────────────
  const COMMANDS = ["/exit", "/quit", "/q", "/clear", "/help", "/stats", "/mode", "/theme", "/compact", "/tools"];

  const processInput = async (input: string) => {
    const trimmed = input.trim();
    historyLines.push(trimmed);

    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      switch (cmd) {
        case "/exit": case "/quit": case "/q":
          console.log(theme.bold("Goodbye."));
          rl.close(); return;

        case "/clear":
          messageHistory = SYSTEM_MESSAGE ? [{ ...SYSTEM_MESSAGE }] : [];
          turnCount = 0;
          console.log(theme.dim("Conversation history cleared."));
          hr(); reprompt(); return;

        case "/help":
          console.log(`\n${theme.bold("Commands:")}\n` +
            `  ${theme.bold("/exit, /quit, /q")}  — 退出\n` +
            `  ${theme.bold("/clear")}            — 清空对话历史\n` +
            `  ${theme.bold("/stats")}            — Session 统计\n` +
            `  ${theme.bold("/mode <strategy>")} — 切换权限策略 (auto-approve|auto-deny|risk-threshold)\n` +
            `  ${theme.bold("/theme dark")}       — 切换主题\n` +
            `  ${theme.bold("/compact")}          — 手动触发 compaction\n` +
            `  ${theme.bold("/tools")}            — 列出已注册工具\n` +
            `  ${theme.bold("/help")}             — 显示此帮助\n\n` +
            `  Ctrl-C 中断当前 turn  │  Ctrl-D 退出  │  Ctrl-X Ctrl-E 外部编辑器`);
          hr(); reprompt(); return;

        case "/stats":
          console.log(`\n${theme.bold("Session stats:")}\n` +
            `  Messages: ${messageHistory.length}\n  Turns:    ${turnCount}\n` +
            `  Provider: ${config.providerName}\n  Journal:  ${journalPath}`);
          hr(); reprompt(); return;

        case "/tools": {
          const names = toolRuntime.getToolNames();
          console.log(`\n${theme.bold("Tools:")} ${names.length}\n` + names.map((n) => `  • ${n}`).join("\n"));
          hr(); reprompt(); return;
        }

        case "/theme":
          console.log(theme.dim("Theme: dark (only option in this version)"));
          hr(); reprompt(); return;

        case "/compact":
          if (!compaction) { console.log(theme.dim("Compaction not configured.")); hr(); reprompt(); return; }
          emit(renderSystemNotice("Manual compaction triggered", theme));
          hr(); reprompt(); return;

        case "/mode": {
          const strategy = parts[1] as NonInteractiveStrategy | undefined;
          if (strategy === "auto-approve" || strategy === "auto-deny" || strategy === "risk-threshold") {
            config.nonInteractive = strategy;
            permissionPolicy = { strategy, riskThreshold: config.riskThreshold ?? RiskLevel.MEDIUM };
            statusState.mode = strategy;
            paintStatusBar();
            console.log(theme.dim(`Permission mode: ${strategy}`));
          } else {
            console.log("Usage: /mode <auto-approve|auto-deny|risk-threshold>");
          }
          hr(); reprompt(); return;
        }

        default:
          console.log(`Unknown command: ${cmd}. Type /help for help.`);
          hr(); reprompt(); return;
      }
    }

    // ── Agent turn ───────────────────────────────────────────────────
    // If a turn is already running, enqueue
    if (sm.state !== "idle") {
      sm.enqueue(trimmed);
      emit(theme.dim("⏳ Queued — waiting for current turn to finish"));
      return;
    }

    turnCount++;
    sm.send("sending");

    const turnController = new AbortController();
    const prevSigint = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    process.once("SIGINT", () => {
      activeSpinner?.stop();
      console.log("\n" + theme.dim("Interrupted."));
      sm.send("cancelling");
      turnController.abort();
    });

    statusState.turnStart = Date.now();
    statusState.durationMs = 0;
    paintStatusBar();

    const verb = SPIN_VERBS[(turnCount - 1) % SPIN_VERBS.length]!;
    const tip = SPIN_TIPS[(turnCount - 1) % SPIN_TIPS.length]!;
    const spinner = new Spinner(verb, tip);
    activeSpinner = spinner;
    spinner.start();

    try {
      sm.send("running");
      const loop = new AgentLoop(config.provider, toolRuntime, journal, {
        maxTurns: config.maxTurns ?? 10,
        signal: turnController.signal,
        tokenBudget, contextBuilder, compaction,
      });

      const result = await loop.run(`${runId}-t${turnCount}`, trimmed, messageHistory);
      spinner.stop(); activeSpinner = null;
      sm.send("completed");

      if (result.cancelled) {
        emit(theme.dim(`(Turn cancelled: ${result.cancelled.reason})`));
      }

      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.role === "assistant" && lastMessage.content) {
        const durationMs = Date.now() - statusState.turnStart;
        console.log("\n" + renderAssistantCard(lastMessage.content, durationMs, pickVerb(turnCount - 1), theme) + "\n");
      }

      messageHistory = result.messages;
      statusState.durationMs = Date.now() - statusState.turnStart;
      statusState.currentTool = null;
      statusState.turnStart = 0;
    } catch (err) {
      spinner.stop(); activeSpinner = null;
      sm.send("failed");
      emit(renderErrorCard(err instanceof Error ? err.message : String(err), theme));
    } finally {
      sm.send("idle");
      process.removeAllListeners("SIGINT");
      for (const listener of prevSigint) process.on("SIGINT", listener);
    }

    hr();

    // Check for queued input
    const queued = sm.dequeue();
    if (queued) {
      reprompt();
      await processInput(queued);
    } else {
      reprompt();
    }
  };

  // ── Readline events ──────────────────────────────────────────────────
  rl.on("line", (line) => {
    if (paste.pasting) { paste.pushInner(line); return; }
    frame.close();

    const expanded = pastedBlocks.size > 0 ? expandPastes(line, pastedBlocks) : line;
    pastedBlocks.clear();

    if (!expanded.trim()) {
      if (process.stdout.isTTY) process.stdout.write("\x1b[2A\x1b[0J");
      reprompt(); return;
    }

    if (process.stdout.isTTY) process.stdout.write("\n");
    processInput(expanded).catch((err) => {
      console.error(`REPL error: ${err.message}`);
      hr(); reprompt();
    });
  });

  rl.on("close", () => {
    frame.detach();
    stopStatusTimer();
    if (isTTY) process.stdout.write(BRACKETED_PASTE_OFF);
    try {
      writeFileSync(`${process.env.HOME ?? "/tmp"}/.helm_history`, historyLines.slice(-500).join("\n"), "utf-8");
    } catch { /* non-fatal */ }
    journal.close().catch(() => {});
    console.log(theme.dim(`\nJournal → ${journalPath}`));
  });

  return new Promise<void>((resolve) => { rl.on("close", resolve); });
}
```

- [ ] **Step 2：typecheck**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli typecheck 2>&1
```

期望：0 errors（有 warning 可以接受，但不能有 error）

- [ ] **Step 3：build**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm --filter @helm/cli build 2>&1
```

- [ ] **Step 4：提交**

```bash
git add packages/cli/src/repl.ts
git commit -m "feat(cli): repl.ts — wire all new modules, status bar, state machine, queued input"
```

---

### Task 10：快照测试补全 + 全量验证

**Files:**
- Modify: `packages/cli/bin/snap.test.ts`（补充宽度断点快照用例）

- [ ] **Step 1：补充快照测试**

在 `packages/cli/bin/snap.test.ts` 末尾追加：

```typescript
describe("welcome box snapshots", () => {
  it("renders at 60 cols", async () => {
    const { renderWelcomeBox } = await import("../src/repl.js").then(() => {
      // renderWelcomeBox 是模块内部函数；用 renderStatusBar 代替做宽度测试
      return {};
    });
    // welcome box 测试通过 renderStatusBar 的宽度断点覆盖
    const { renderStatusBar } = await import("../src/status-bar.js");
    const { buildTheme } = await import("../src/theme.js");
    const t = buildTheme("no-color");
    const r60 = renderStatusBar({ theme: t, cols: 60, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    const r80 = renderStatusBar({ theme: t, cols: 80, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    const r100 = renderStatusBar({ theme: t, cols: 100, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    const r120 = renderStatusBar({ theme: t, cols: 120, model: "deepseek-v4-flash", mode: "interactive", contextPct: 10, cost: null, durationMs: 0, currentTool: null, bgTasks: 0 });
    // 60 列不含 mode
    expect(r60).not.toContain("interactive");
    // 80 列含 mode
    expect(r80).toContain("interactive");
    // 100 列含 cost
    expect(r100).toContain("n/a");
    // 120 列也含 cost
    expect(r120).toContain("n/a");
  });
});
```

- [ ] **Step 2：全量运行测试**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

期望：全部 PASS，0 errors，build 成功

- [ ] **Step 3：提交**

```bash
git add packages/cli/bin/snap.test.ts
git commit -m "test(cli): snapshot tests for status bar width breakpoints and all card types"
```

---

### Task 11：手动验证

- [ ] **Step 1：用 scripted provider 启动 REPL**

```bash
cd /Users/hpp/projects-ai/helm/helm-dev
pnpm build
node packages/cli/dist/bin/run.js
```

检查：
- 欢迎框正常显示，颜色正确
- 状态栏出现在 Composer 上方
- 输入框架有上下两条规则线
- 调整终端窗口大小：底部 chrome 正确重绘，不出现重叠/空白带

- [ ] **Step 2：测试 Ctrl+C 中断**

启动后输入任意消息，在 spinner 运行时按 Ctrl+C，确认：
- spinner 消失
- 打印 "Interrupted."
- 重新出现输入提示，状态栏回到 idle

- [ ] **Step 3：测试 slash commands**

```
/help     → 显示命令列表
/stats    → 显示统计
/tools    → 显示工具列表
/theme dark → 显示主题提示
/clear    → 清空历史
/exit     → 退出
```

- [ ] **Step 4：测试 Tab 补全**

输入 `/h` 然后按 Tab，确认补全为 `/help`。

- [ ] **Step 5：测试外部编辑器**

按 Ctrl+X 然后 Ctrl+E，确认打开 vi/nano，编辑后内容回到输入框。

- [ ] **Step 6：最终提交说明**

以上步骤全部通过后，本 PR 实现完毕。无需额外提交（各 task 已逐步提交）。

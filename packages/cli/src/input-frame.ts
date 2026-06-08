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

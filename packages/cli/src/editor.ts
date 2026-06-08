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

  // 5. Re-enable raw mode
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
  deps.rl.line = content.replace(/\n$/, "");
  deps.rl.cursor = deps.rl.line.length;
  deps.rl._refreshLine();

  // 8. Resume TUI
  deps.rl.resume();
  deps.frame.repaint();
  deps.onStatusResume();

  return true;
}

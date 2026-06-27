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

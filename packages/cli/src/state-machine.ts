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

  enqueue(input: string): void {
    this._pendingInput = input;
    if (this._state !== "queued") {
      this._state = "queued";
      for (const l of this.listeners) l(this._state);
    }
  }

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

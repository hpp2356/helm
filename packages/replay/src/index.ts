import { type RunEvent } from "@helm/core";
import * as fs from "node:fs";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReadWarning {
  line: number;
  message: string;
}

export interface ReadResult {
  events: RunEvent[];
  warnings: ReadWarning[];
}

export interface RunSummary {
  eventCounts: Record<string, number>;
  turnCount: number;
  toolCallCounts: Record<string, number>;
  errorCount: number;
  errorsByCategory: Record<string, number>;
  retryAttemptCount: number;
  retryExhausted: boolean;
  durationMs: number | null;
  cancelled: boolean;
  cancelledReason: "external" | "timeout" | null;
  exitCode: number | null;
}

export type ReplayObserver = (event: RunEvent, index: number) => void;

// ── Known event types ─────────────────────────────────────────────────────

const KNOWN_EVENT_TYPES = new Set([
  "run:start",
  "run:end",
  "turn:start",
  "turn:end",
  "tool:call",
  "tool:result",
  "error",
  "run:cancelled",
  "retry",
]);

// ── JournalReader ─────────────────────────────────────────────────────────

function isRunEvent(obj: unknown): obj is RunEvent {
  if (obj === null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o.type === "string" && typeof o.timestamp === "number";
}

export function readJournal(filePath: string): ReadResult {
  const warnings: ReadWarning[] = [];
  let raw: string;

  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new ReadError(`Cannot read journal file: ${filePath}`, filePath);
  }

  const content = raw.trim();
  if (!content) {
    return { events: [], warnings: [] };
  }

  const lines = content.split("\n");
  const events: RunEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push({
        line: i + 1,
        message: `Malformed JSON on line ${i + 1}`,
      });
      continue;
    }

    if (!isRunEvent(parsed)) {
      warnings.push({
        line: i + 1,
        message: `Line ${i + 1}: missing required fields "type" and/or "timestamp"`,
      });
      continue;
    }

    const event = parsed as RunEvent;
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      warnings.push({
        line: i + 1,
        message: `Unknown event type "${event.type}" on line ${i + 1}`,
      });
    }

    events.push(event);
  }

  return { events, warnings };
}

// ── Replay ────────────────────────────────────────────────────────────────

export function replayEvents(
  events: RunEvent[],
  observer?: ReplayObserver,
): void {
  events.forEach((event, index) => {
    observer?.(event, index);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────

export function computeStats(events: RunEvent[]): RunSummary {
  const eventCounts: Record<string, number> = {};
  const toolCallCounts: Record<string, number> = {};
  const errorsByCategory: Record<string, number> = {};
  let turnCount = 0;
  let errorCount = 0;
  let retryAttemptCount = 0;
  let retryExhausted = false;
  let cancelled = false;
  let cancelledReason: "external" | "timeout" | null = null;
  let exitCode: number | null = null;
  let startTimestamp: number | null = null;
  let endTimestamp: number | null = null;

  for (const event of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;

    switch (event.type) {
      case "run:start":
        startTimestamp = event.timestamp;
        break;

      case "run:end":
        endTimestamp = event.timestamp;
        exitCode = event.exitCode;
        break;

      case "turn:start":
        turnCount++;
        break;

      case "tool:call":
        toolCallCounts[event.toolName] =
          (toolCallCounts[event.toolName] ?? 0) + 1;
        break;

      case "error":
        errorCount++;
        if (event.errorCategory) {
          errorsByCategory[event.errorCategory] =
            (errorsByCategory[event.errorCategory] ?? 0) + 1;
        }
        break;

      case "retry":
        if (event.phase === "attempt") {
          retryAttemptCount++;
        } else if (event.phase === "exhausted") {
          retryExhausted = true;
        }
        break;

      case "run:cancelled":
        cancelled = true;
        cancelledReason = event.reason;
        break;
    }
  }

  const durationMs =
    startTimestamp !== null && endTimestamp !== null
      ? endTimestamp - startTimestamp
      : null;

  return {
    eventCounts,
    turnCount,
    toolCallCounts,
    errorCount,
    errorsByCategory,
    retryAttemptCount,
    retryExhausted,
    durationMs,
    cancelled,
    cancelledReason,
    exitCode,
  };
}

// ── ReadError ─────────────────────────────────────────────────────────────

export class ReadError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = "ReadError";
    this.filePath = filePath;
  }
}

import { describe, it, expect } from "vitest";
import {
  readJournal,
  replayEvents,
  computeStats,
  ReadError,
  type ReadResult,
  type RunSummary,
} from "./index.js";
import { JsonlJournal, type RunEvent } from "@helm/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeJournalFile(events: RunEvent[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
  const filePath = path.join(dir, "journal.jsonl");
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf-8");
  return filePath;
}

const baseTime = 1700000000000;

// ── readJournal tests ─────────────────────────────────────────────────────

describe("readJournal", () => {
  it("reads a valid journal file and returns RunEvent[]", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "r1", timestamp: baseTime },
      { type: "turn:start", runId: "r1", turnIndex: 0, timestamp: baseTime + 1 },
      { type: "run:end", runId: "r1", timestamp: baseTime + 2, exitCode: 0 },
    ];
    const filePath = makeJournalFile(events);

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    expect(result.events[0].type).toBe("run:start");
    expect(result.events[1].type).toBe("turn:start");
    expect(result.events[2].type).toBe("run:end");

    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("returns empty array for empty file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf-8");

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array for whitespace-only file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "blank.jsonl");
    fs.writeFileSync(filePath, "  \n  \n", "utf-8");

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles malformed JSON with line number in warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "bad.jsonl");
    fs.writeFileSync(
      filePath,
      '{"type":"run:start","runId":"r1","timestamp":1}\nthis is not json\n',
      "utf-8",
    );

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("run:start");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].line).toBe(2);
    expect(result.warnings[0].message).toContain("Malformed JSON");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns on unknown event type but still includes it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "unknown.jsonl");
    fs.writeFileSync(
      filePath,
      '{"type":"unknown:event","timestamp":1}\n',
      "utf-8",
    );

    const result = readJournal(filePath);
    // Event is included despite unknown type
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("unknown:event");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain("Unknown event type");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns on missing required fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "badfields.jsonl");
    fs.writeFileSync(filePath, '{"foo":"bar"}\n', "utf-8");

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain("missing required fields");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles null value gracefully", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "null.jsonl");
    fs.writeFileSync(filePath, "null\n", "utf-8");

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws ReadError for non-existent file", () => {
    expect(() => readJournal("/tmp/helm-nonexistent-file-12345.jsonl")).toThrow(
      ReadError,
    );
    try {
      readJournal("/tmp/helm-nonexistent-file-12345.jsonl");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadError);
      expect((err as ReadError).filePath).toContain("nonexistent");
    }
  });

  it("round-trips correctly with JsonlJournal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "roundtrip.jsonl");

    const events: RunEvent[] = [
      { type: "run:start", runId: "rt", timestamp: 1000 },
      { type: "turn:start", runId: "rt", turnIndex: 0, timestamp: 1001 },
      {
        type: "tool:call",
        runId: "rt",
        turnIndex: 0,
        toolName: "calc",
        args: { expr: "1+1" },
        timestamp: 1002,
      },
      {
        type: "tool:result",
        runId: "rt",
        turnIndex: 0,
        toolName: "calc",
        output: "2",
        timestamp: 1003,
      },
      { type: "run:end", runId: "rt", timestamp: 1004, exitCode: 0 },
    ];

    const journal = new JsonlJournal(filePath);
    await journal.open();
    for (const e of events) {
      await journal.append(e);
    }
    await journal.close();

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(5);
    expect(result.events[0]).toEqual(events[0]);
    expect(result.events[1]).toEqual(events[1]);
    expect(result.events[2]).toEqual(events[2]);
    expect(result.events[3]).toEqual(events[3]);
    expect(result.events[4]).toEqual(events[4]);
    expect(result.warnings).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips blank lines between events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "withblanks.jsonl");
    fs.writeFileSync(
      filePath,
      '{"type":"run:start","runId":"r1","timestamp":1}\n\n{"type":"run:end","runId":"r1","timestamp":2,"exitCode":0}\n',
      "utf-8",
    );

    const result = readJournal(filePath);
    expect(result.events).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── replayEvents tests ────────────────────────────────────────────────────

describe("replayEvents", () => {
  it("calls observer for each event in order with index", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "r1", timestamp: 1 },
      { type: "run:end", runId: "r1", timestamp: 2, exitCode: 0 },
    ];

    const observed: Array<{ event: RunEvent; index: number }> = [];
    replayEvents(events, (event, index) => {
      observed.push({ event, index });
    });

    expect(observed).toHaveLength(2);
    expect(observed[0].index).toBe(0);
    expect(observed[0].event.type).toBe("run:start");
    expect(observed[1].index).toBe(1);
    expect(observed[1].event.type).toBe("run:end");
  });

  it("does not throw when observer is undefined", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "r1", timestamp: 1 },
    ];

    expect(() => replayEvents(events)).not.toThrow();
    expect(() => replayEvents(events, undefined)).not.toThrow();
  });

  it("handles empty events array", () => {
    const observed: RunEvent[] = [];
    replayEvents([], (event) => observed.push(event));
    expect(observed).toHaveLength(0);
  });
});

// ── computeStats tests ─────────────────────────────────────────────────────

describe("computeStats", () => {
  it("computes event counts by type", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      { type: "turn:start", runId: "s1", turnIndex: 0, timestamp: 2 },
      { type: "turn:start", runId: "s1", turnIndex: 1, timestamp: 3 },
      { type: "run:end", runId: "s1", timestamp: 4, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.eventCounts["run:start"]).toBe(1);
    expect(stats.eventCounts["turn:start"]).toBe(2);
    expect(stats.eventCounts["run:end"]).toBe(1);
    expect(stats.turnCount).toBe(2);
  });

  it("computes turn count correctly", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      { type: "turn:start", runId: "s1", turnIndex: 0, timestamp: 2 },
      { type: "turn:start", runId: "s1", turnIndex: 1, timestamp: 3 },
      { type: "turn:start", runId: "s1", turnIndex: 2, timestamp: 4 },
      { type: "run:end", runId: "s1", timestamp: 5, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.turnCount).toBe(3);
  });

  it("computes tool call counts", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      {
        type: "tool:call",
        runId: "s1",
        turnIndex: 0,
        toolName: "calc",
        args: {},
        timestamp: 2,
      },
      {
        type: "tool:call",
        runId: "s1",
        turnIndex: 0,
        toolName: "echo",
        args: {},
        timestamp: 3,
      },
      {
        type: "tool:call",
        runId: "s1",
        turnIndex: 1,
        toolName: "calc",
        args: {},
        timestamp: 4,
      },
      { type: "run:end", runId: "s1", timestamp: 5, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.toolCallCounts["calc"]).toBe(2);
    expect(stats.toolCallCounts["echo"]).toBe(1);
  });

  it("computes error counts and categories", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      {
        type: "error",
        runId: "s1",
        message: "rate limit",
        errorType: "provider",
        errorCategory: "rate_limit",
        timestamp: 2,
      },
      {
        type: "error",
        runId: "s1",
        message: "timeout",
        errorType: "provider",
        errorCategory: "timeout",
        timestamp: 3,
      },
      {
        type: "error",
        runId: "s1",
        message: "rate limit again",
        errorType: "provider",
        errorCategory: "rate_limit",
        timestamp: 4,
      },
      { type: "run:end", runId: "s1", timestamp: 5, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.errorCount).toBe(3);
    expect(stats.errorsByCategory["rate_limit"]).toBe(2);
    expect(stats.errorsByCategory["timeout"]).toBe(1);
  });

  it("computes retry stats", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      {
        type: "retry",
        runId: "s1",
        turnIndex: 0,
        phase: "attempt",
        attemptNumber: 2,
        maxAttempts: 3,
        errorMessage: "fail",
        delayMs: 10,
        timestamp: 2,
      },
      {
        type: "retry",
        runId: "s1",
        turnIndex: 0,
        phase: "attempt",
        attemptNumber: 3,
        maxAttempts: 3,
        errorMessage: "fail",
        delayMs: 20,
        timestamp: 3,
      },
      {
        type: "retry",
        runId: "s1",
        turnIndex: 0,
        phase: "exhausted",
        attemptNumber: 3,
        maxAttempts: 3,
        errorMessage: "fail",
        delayMs: 0,
        timestamp: 4,
      },
      { type: "run:end", runId: "s1", timestamp: 5, exitCode: 1 },
    ];

    const stats = computeStats(events);
    expect(stats.retryAttemptCount).toBe(2);
    expect(stats.retryExhausted).toBe(true);
  });

  it("retryExhausted is false when only attempts occur", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      {
        type: "retry",
        runId: "s1",
        turnIndex: 0,
        phase: "attempt",
        attemptNumber: 2,
        maxAttempts: 3,
        errorMessage: "fail",
        delayMs: 10,
        timestamp: 2,
      },
      { type: "run:end", runId: "s1", timestamp: 3, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.retryAttemptCount).toBe(1);
    expect(stats.retryExhausted).toBe(false);
  });

  it("computes duration from run:start to run:end", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1000 },
      { type: "run:end", runId: "s1", timestamp: 1500, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.durationMs).toBe(500);
  });

  it("returns null duration when run:start is missing", () => {
    const events: RunEvent[] = [
      { type: "run:end", runId: "s1", timestamp: 1500, exitCode: 0 },
    ];

    const stats = computeStats(events);
    expect(stats.durationMs).toBeNull();
  });

  it("returns null duration when run:end is missing", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1000 },
    ];

    const stats = computeStats(events);
    expect(stats.durationMs).toBeNull();
  });

  it("detects cancelled state", () => {
    const events: RunEvent[] = [
      { type: "run:start", runId: "s1", timestamp: 1 },
      { type: "run:cancelled", runId: "s1", reason: "timeout", timestamp: 2 },
      { type: "run:end", runId: "s1", timestamp: 3, exitCode: 130 },
    ];

    const stats = computeStats(events);
    expect(stats.cancelled).toBe(true);
    expect(stats.cancelledReason).toBe("timeout");
    expect(stats.exitCode).toBe(130);
  });

  it("handles empty events array", () => {
    const stats = computeStats([]);
    expect(stats.eventCounts).toEqual({});
    expect(stats.turnCount).toBe(0);
    expect(stats.toolCallCounts).toEqual({});
    expect(stats.errorCount).toBe(0);
    expect(stats.errorsByCategory).toEqual({});
    expect(stats.retryAttemptCount).toBe(0);
    expect(stats.retryExhausted).toBe(false);
    expect(stats.durationMs).toBeNull();
    expect(stats.cancelled).toBe(false);
    expect(stats.cancelledReason).toBeNull();
    expect(stats.exitCode).toBeNull();
  });

  it("full integration: write with JsonlJournal, read with readJournal, compute stats", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-replay-test-"));
    const filePath = path.join(dir, "integration.jsonl");

    // Write via JsonlJournal
    const journal = new JsonlJournal(filePath);
    await journal.open();

    const events: RunEvent[] = [
      { type: "run:start", runId: "int", timestamp: 1000 },
      { type: "turn:start", runId: "int", turnIndex: 0, timestamp: 1001 },
      {
        type: "tool:call",
        runId: "int",
        turnIndex: 0,
        toolName: "search",
        args: { q: "hello" },
        timestamp: 1002,
      },
      {
        type: "tool:result",
        runId: "int",
        turnIndex: 0,
        toolName: "search",
        output: "found",
        timestamp: 1003,
      },
      {
        type: "error",
        runId: "int",
        message: "boom",
        errorType: "provider",
        errorCategory: "server_error",
        timestamp: 1004,
      },
      {
        type: "retry",
        runId: "int",
        turnIndex: 0,
        phase: "exhausted",
        attemptNumber: 3,
        maxAttempts: 3,
        errorMessage: "boom",
        delayMs: 0,
        timestamp: 1005,
      },
      { type: "run:end", runId: "int", timestamp: 1100, exitCode: 1 },
    ];

    for (const e of events) {
      await journal.append(e);
    }
    await journal.close();

    // Read via readJournal
    const result = readJournal(filePath);
    expect(result.events).toHaveLength(7);
    expect(result.warnings).toHaveLength(0);

    // Compute stats
    const stats = computeStats(result.events);
    expect(stats.turnCount).toBe(1);
    expect(stats.toolCallCounts["search"]).toBe(1);
    expect(stats.errorCount).toBe(1);
    expect(stats.errorsByCategory["server_error"]).toBe(1);
    expect(stats.retryExhausted).toBe(true);
    expect(stats.durationMs).toBe(100);
    expect(stats.exitCode).toBe(1);

    // Replay observer
    const observed: string[] = [];
    replayEvents(result.events, (e) => observed.push(e.type));
    expect(observed).toEqual([
      "run:start",
      "turn:start",
      "tool:call",
      "tool:result",
      "error",
      "retry",
      "run:end",
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

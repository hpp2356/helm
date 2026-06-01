import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlJournal } from "./journal.js";
import { type RunEvent } from "./events.js";

describe("JsonlJournal", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "helm-journal-test-"));
    filePath = join(tmpDir, "test.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should open, append, and close", async () => {
    const journal = new JsonlJournal(filePath);
    await journal.open();

    const event: RunEvent = {
      type: "run:start",
      runId: "run-1",
      timestamp: 1717200000000,
    };
    await journal.append(event);
    await journal.close();

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toBe(JSON.stringify(event) + "\n");
  });

  it("should append multiple events as separate JSONL lines", async () => {
    const journal = new JsonlJournal(filePath);
    await journal.open();

    const events: RunEvent[] = [
      { type: "run:start", runId: "run-1", timestamp: 1 },
      { type: "turn:start", runId: "run-1", turnIndex: 0, timestamp: 2 },
      { type: "turn:end", runId: "run-1", turnIndex: 0, timestamp: 3 },
      { type: "run:end", runId: "run-1", timestamp: 4, exitCode: 0 },
    ];

    for (const event of events) {
      await journal.append(event);
    }
    await journal.close();

    const contents = await readFile(filePath, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(4);

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.type).toBe(events[i].type);
    }
  });

  it("should throw when appending to a closed journal", async () => {
    const journal = new JsonlJournal(filePath);
    await journal.open();
    await journal.close();

    const event: RunEvent = {
      type: "run:start",
      runId: "run-1",
      timestamp: 1,
    };
    await expect(journal.append(event)).rejects.toThrow("Journal is not open");
  });

  it("should throw when appending to a never-opened journal", async () => {
    const journal = new JsonlJournal(filePath);

    const event: RunEvent = {
      type: "run:start",
      runId: "run-1",
      timestamp: 1,
    };
    await expect(journal.append(event)).rejects.toThrow("Journal is not open");
  });

  it("should reopen and append to an existing file", async () => {
    // First session: write one event
    const journal1 = new JsonlJournal(filePath);
    await journal1.open();
    await journal1.append({
      type: "run:start",
      runId: "run-1",
      timestamp: 1,
    });
    await journal1.close();

    // Second session: append another event
    const journal2 = new JsonlJournal(filePath);
    await journal2.open();
    await journal2.append({
      type: "run:end",
      runId: "run-1",
      timestamp: 2,
      exitCode: 0,
    });
    await journal2.close();

    const contents = await readFile(filePath, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.type).toBe("run:start");

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1.type).toBe("run:end");
  });

  it("should close safely when never opened", async () => {
    const journal = new JsonlJournal(filePath);
    // Should not throw
    await journal.close();
  });
});

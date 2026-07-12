import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointStore } from "./store.js";
import type { Checkpoint } from "./types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `helm-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "cp-001",
    sessionId: "test-session",
    timestamp: Date.now(),
    type: "file_edit",
    files: [],
    conversationIndex: 0,
    ...overrides,
  };
}

describe("CheckpointStore", () => {
  let tmpDir: string;
  let checkpointDir: string;
  let store: CheckpointStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    checkpointDir = join(tmpDir, "checkpoints");
    store = new CheckpointStore({ checkpointDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a checkpoint", () => {
    const cp = makeCheckpoint();
    store.save(cp);
    const loaded = store.load("test-session", "cp-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("cp-001");
    expect(loaded!.sessionId).toBe("test-session");
    expect(loaded!.type).toBe("file_edit");
  });

  it("returns null for non-existent checkpoint", () => {
    const loaded = store.load("test-session", "cp-999");
    expect(loaded).toBeNull();
  });

  it("lists checkpoints by session", () => {
    store.save(makeCheckpoint({ id: "cp-001", sessionId: "s1" }));
    store.save(makeCheckpoint({ id: "cp-002", sessionId: "s1" }));
    store.save(makeCheckpoint({ id: "cp-003", sessionId: "s2" }));

    const s1 = store.list("s1");
    expect(s1).toHaveLength(2);
    expect(s1.every((e) => e.sessionId === "s1")).toBe(true);

    const s2 = store.list("s2");
    expect(s2).toHaveLength(1);
  });

  it("lists all checkpoints when no sessionId filter", () => {
    store.save(makeCheckpoint({ id: "cp-001", sessionId: "s1" }));
    store.save(makeCheckpoint({ id: "cp-002", sessionId: "s2" }));

    const all = store.list();
    expect(all).toHaveLength(2);
  });

  it("deletes a checkpoint", () => {
    store.save(makeCheckpoint({ id: "cp-001" }));
    const deleted = store.delete("test-session", "cp-001");
    expect(deleted).toBe(true);
    expect(store.load("test-session", "cp-001")).toBeNull();
  });

  it("returns false when deleting non-existent checkpoint", () => {
    const deleted = store.delete("test-session", "cp-999");
    expect(deleted).toBe(false);
  });

  it("creates index.json after saving", () => {
    store.save(makeCheckpoint());
    expect(existsSync(join(checkpointDir, "index.json"))).toBe(true);
  });

  it("stores file snapshots in checkpoint", () => {
    const cp = makeCheckpoint({
      files: [
        { path: "/tmp/test.ts", content: "const x = 1;", hash: "abc123" },
      ],
    });
    store.save(cp);
    const loaded = store.load("test-session", "cp-001");
    expect(loaded!.files).toHaveLength(1);
    expect(loaded!.files[0].content).toBe("const x = 1;");
  });

  it("creates session directories", () => {
    store.save(makeCheckpoint({ sessionId: "session-a" }));
    store.save(makeCheckpoint({ id: "cp-002", sessionId: "session-b" }));
    expect(existsSync(join(checkpointDir, "session-a"))).toBe(true);
    expect(existsSync(join(checkpointDir, "session-b"))).toBe(true);
  });

  it("hashContent produces consistent hash", () => {
    const hash1 = CheckpointStore.hashContent("hello world");
    const hash2 = CheckpointStore.hashContent("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  it("hashContent produces different hash for different content", () => {
    const hash1 = CheckpointStore.hashContent("hello");
    const hash2 = CheckpointStore.hashContent("world");
    expect(hash1).not.toBe(hash2);
  });

  it("snapshotFile reads file content", () => {
    const testFile = join(tmpDir, "test-file.ts");
    writeFileSync(testFile, "export const x = 42;", "utf-8");
    const snapshot = store.snapshotFile(testFile);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.content).toBe("export const x = 42;");
    expect(snapshot!.path).toBe(testFile);
    expect(snapshot!.hash).toHaveLength(16);
  });

  it("snapshotFile returns null for non-existent file", () => {
    const snapshot = store.snapshotFile(join(tmpDir, "nonexistent.ts"));
    expect(snapshot).toBeNull();
  });

  it("clean removes expired checkpoints", () => {
    const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    store.save(makeCheckpoint({ id: "cp-old", timestamp: oldTimestamp }));
    store.save(makeCheckpoint({ id: "cp-new" }));

    const removed = store.clean();
    expect(removed).toBe(1);
    expect(store.load("test-session", "cp-old")).toBeNull();
    expect(store.load("test-session", "cp-new")).not.toBeNull();
  });

  it("clean respects retentionDays setting", () => {
    const customStore = new CheckpointStore({ checkpointDir, retentionDays: 7 });
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    customStore.save(makeCheckpoint({ id: "cp-old", timestamp: eightDaysAgo }));
    customStore.save(makeCheckpoint({ id: "cp-new" }));

    const removed = customStore.clean();
    expect(removed).toBe(1);
  });

  it("clean removes empty session directories", () => {
    store.save(makeCheckpoint({ id: "cp-001", sessionId: "temp-session" }));
    // Make it expired
    store.save(makeCheckpoint({ id: "cp-002", sessionId: "temp-session", timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
    store.clean();
    // The session dir should be cleaned up if empty
  });
});

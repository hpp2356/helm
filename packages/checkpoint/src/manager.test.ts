import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "./manager.js";
import { CheckpointStore } from "./store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `helm-checkpoint-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CheckpointManager", () => {
  let tmpDir: string;
  let checkpointDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    checkpointDir = join(tmpDir, "checkpoints");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates checkpoint from file edit", () => {
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "const x = 1;", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromFileEdit([testFile], 0, "initial edit");

    expect(cp).not.toBeNull();
    expect(cp!.type).toBe("file_edit");
    expect(cp!.files).toHaveLength(1);
    expect(cp!.files[0].content).toBe("const x = 1;");
    expect(cp!.conversationIndex).toBe(0);
    expect(cp!.description).toBe("initial edit");
  });

  it("creates checkpoint from prompt", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromPrompt("fix the bug", 5);

    expect(cp).not.toBeNull();
    expect(cp!.type).toBe("prompt");
    expect(cp!.promptText).toBe("fix the bug");
    expect(cp!.conversationIndex).toBe(5);
  });

  it("creates session start checkpoint", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createSessionStart(0);

    expect(cp).not.toBeNull();
    expect(cp!.type).toBe("session_start");
    expect(cp!.description).toBe("Session start");
  });

  it("returns null when disabled", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir, enabled: false });
    expect(mgr.createFromFileEdit([], 0)).toBeNull();
    expect(mgr.createFromPrompt("test", 0)).toBeNull();
    expect(mgr.createSessionStart(0)).toBeNull();
  });

  it("lists checkpoints for current session", () => {
    const testFile = join(tmpDir, "list-test.ts");
    writeFileSync(testFile, "content", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    mgr.createSessionStart(0);
    mgr.createFromPrompt("do something", 1);
    mgr.createFromFileEdit([testFile], 2, "edited file");

    const list = mgr.list();
    expect(list).toHaveLength(3);
    expect(list[0].type).toBe("session_start");
    expect(list[1].type).toBe("prompt");
    expect(list[2].type).toBe("file_edit");
  });

  it("auto-increments checkpoint IDs", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp1 = mgr.createSessionStart(0);
    const cp2 = mgr.createFromPrompt("test", 1);
    const cp3 = mgr.createSessionStart(2);

    expect(cp1!.id).toBe("cp-001");
    expect(cp2!.id).toBe("cp-002");
    expect(cp3!.id).toBe("cp-003");
  });

  it("restores code from checkpoint", () => {
    const testFile = join(tmpDir, "restore-test.ts");
    writeFileSync(testFile, "original content", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromFileEdit([testFile], 0);

    // Modify the file
    writeFileSync(testFile, "modified content", "utf-8");
    expect(readFileSync(testFile, "utf-8")).toBe("modified content");

    // Restore
    const result = mgr.restore(cp!.id, "code");
    expect(result).not.toBeNull();
    expect(result!.filesRestored).toContain(testFile);
    expect(readFileSync(testFile, "utf-8")).toBe("original content");
  });

  it("restores code+conversation from checkpoint", () => {
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "content-v1", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromFileEdit([testFile], 3);

    const result = mgr.restore(cp!.id, "code+conversation");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("code+conversation");
    expect(result!.conversationIndex).toBe(3);
    expect(result!.filesRestored).toHaveLength(1);
  });

  it("restores conversation only (no code changes)", () => {
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "original", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromFileEdit([testFile], 2);

    writeFileSync(testFile, "changed", "utf-8");

    const result = mgr.restore(cp!.id, "conversation");
    expect(result).not.toBeNull();
    expect(result!.filesRestored).toHaveLength(0);
    expect(result!.conversationIndex).toBe(2);
    // File should NOT be restored
    expect(readFileSync(testFile, "utf-8")).toBe("changed");
  });

  it("returns null for non-existent checkpoint restore", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const result = mgr.restore("cp-999", "code");
    expect(result).toBeNull();
  });

  it("skips files larger than maxFileSize", () => {
    const smallFile = join(tmpDir, "small.ts");
    const largeFile = join(tmpDir, "large.ts");
    writeFileSync(smallFile, "small", "utf-8");
    writeFileSync(largeFile, "x".repeat(2 * 1024 * 1024), "utf-8"); // 2MB

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir, maxFileSize: 1024 * 1024 });
    const cp = mgr.createFromFileEdit([smallFile, largeFile], 0);

    expect(cp!.files).toHaveLength(1);
    expect(cp!.files[0].path).toBe(smallFile);
  });

  it("creates checkpoints for multiple files", () => {
    const f1 = join(tmpDir, "a.ts");
    const f2 = join(tmpDir, "b.ts");
    writeFileSync(f1, "a content", "utf-8");
    writeFileSync(f2, "b content", "utf-8");

    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const cp = mgr.createFromFileEdit([f1, f2], 0);

    expect(cp!.files).toHaveLength(2);
  });

  it("get returns checkpoint by id", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const created = mgr.createSessionStart(0);
    const loaded = mgr.get(created!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created!.id);
  });

  it("listAll returns checkpoints from all sessions", () => {
    const mgr1 = new CheckpointManager({ sessionId: "s1", checkpointDir });
    const mgr2 = new CheckpointManager({ sessionId: "s2", checkpointDir });
    mgr1.createSessionStart(0);
    mgr2.createSessionStart(0);
    mgr2.createFromPrompt("test", 1);

    const all = mgr1.listAll();
    expect(all).toHaveLength(3);
  });

  it("clean removes expired checkpoints", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    // Create via store to set custom timestamp
    const store = new CheckpointStore({ checkpointDir });
    store.save({
      id: "cp-old",
      sessionId: "s1",
      timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000,
      type: "session_start",
      files: [],
      conversationIndex: 0,
    });
    mgr.createSessionStart(0);

    const removed = mgr.clean();
    expect(removed).toBe(1);
  });

  it("default description is set based on type", () => {
    const mgr = new CheckpointManager({ sessionId: "s1", checkpointDir });
    mgr.createSessionStart(0);
    const list = mgr.list();
    expect(list[0].description).toBe("Session start");
  });
});

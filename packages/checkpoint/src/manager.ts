import * as fs from "node:fs";
import * as path from "node:path";
import { CheckpointStore } from "./store.js";
import type {
  Checkpoint,
  CheckpointListEntry,
  CheckpointManagerOptions,
  FileSnapshot,
  RestoreAction,
  RestoreResult,
} from "./types.js";

// ── Checkpoint Manager ───────────────────────────────────────────────────
// High-level API for checkpoint lifecycle: create, restore, summarize.

export class CheckpointManager {
  private store: CheckpointStore;
  private sessionId: string;
  private counter = 0;
  private enabled: boolean;
  private maxFileSize: number;

  constructor(opts: CheckpointManagerOptions) {
    this.store = new CheckpointStore({
      checkpointDir: opts.checkpointDir,
      retentionDays: opts.retentionDays,
    });
    this.sessionId = opts.sessionId;
    this.enabled = opts.enabled !== false;
    this.maxFileSize = opts.maxFileSize ?? 1024 * 1024; // 1MB default
  }

  // ── Checkpoint creation ────────────────────────────────────────────────

  createFromFileEdit(
    filePaths: string[],
    conversationIndex: number,
    description?: string,
  ): Checkpoint | null {
    if (!this.enabled) return null;

    const files: FileSnapshot[] = [];
    for (const fp of filePaths) {
      // Skip files that are too large
      try {
        const stat = fs.statSync(fp);
        if (stat.size > this.maxFileSize) continue;
      } catch {
        // file may not exist yet — that's ok for write tools
      }
      const snapshot = this.store.snapshotFile(fp);
      if (snapshot) files.push(snapshot);
    }

    if (files.length === 0) return null;

    const checkpoint: Checkpoint = {
      id: this.nextId(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: "file_edit",
      files,
      conversationIndex,
      description,
    };

    this.store.save(checkpoint);
    return checkpoint;
  }

  createFromPrompt(
    promptText: string,
    conversationIndex: number,
  ): Checkpoint | null {
    if (!this.enabled) return null;

    const checkpoint: Checkpoint = {
      id: this.nextId(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: "prompt",
      files: [],
      conversationIndex,
      promptText,
    };

    this.store.save(checkpoint);
    return checkpoint;
  }

  createSessionStart(conversationIndex: number): Checkpoint | null {
    if (!this.enabled) return null;

    const checkpoint: Checkpoint = {
      id: this.nextId(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: "session_start",
      files: [],
      conversationIndex,
      description: "Session start",
    };

    this.store.save(checkpoint);
    return checkpoint;
  }

  // ── Checkpoint listing ─────────────────────────────────────────────────

  list(): CheckpointListEntry[] {
    return this.store.list(this.sessionId).map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      description: e.description ?? this.defaultDescription(e.type),
      fileCount: e.fileCount,
      conversationIndex: e.conversationIndex,
    }));
  }

  listAll(): CheckpointListEntry[] {
    return this.store.list().map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      description: e.description ?? this.defaultDescription(e.type),
      fileCount: e.fileCount,
      conversationIndex: e.conversationIndex,
    }));
  }

  // ── Restore ────────────────────────────────────────────────────────────

  restore(
    checkpointId: string,
    action: RestoreAction,
  ): RestoreResult | null {
    const checkpoint = this.store.load(this.sessionId, checkpointId);
    if (!checkpoint) return null;

    const filesRestored: string[] = [];

    if (action === "code+conversation" || action === "code") {
      for (const snapshot of checkpoint.files) {
        try {
          const dir = path.dirname(snapshot.path);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(snapshot.path, snapshot.content, "utf-8");
          filesRestored.push(snapshot.path);
        } catch {
          // skip files that can't be restored
        }
      }
    }

    return {
      action,
      checkpointId,
      filesRestored,
      conversationIndex: checkpoint.conversationIndex,
    };
  }

  // ── Checkpoint retrieval ───────────────────────────────────────────────

  get(checkpointId: string): Checkpoint | null {
    return this.store.load(this.sessionId, checkpointId);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  clean(): number {
    return this.store.clean();
  }

  // ── Git checkpoint ─────────────────────────────────────────────────────

  async gitCheckpoint(
    action: "stash" | "commit",
    message?: string,
  ): Promise<{ success: boolean; output: string }> {
    const { execSync } = await import("node:child_process");
    const label = `helm-checkpoint: ${message ?? this.nextId()}`;

    try {
      if (action === "stash") {
        const output = execSync(`git stash push -m "${label}"`, {
          encoding: "utf-8",
          timeout: 10000,
        });
        return { success: true, output: output.trim() };
      } else {
        execSync("git add -A", { encoding: "utf-8", timeout: 10000 });
        const output = execSync(`git commit -m "${label}" --allow-empty`, {
          encoding: "utf-8",
          timeout: 10000,
        });
        return { success: true, output: output.trim() };
      }
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private nextId(): string {
    this.counter++;
    const seq = String(this.counter).padStart(3, "0");
    return `cp-${seq}`;
  }

  private defaultDescription(type: string): string {
    switch (type) {
      case "file_edit":
        return "File edit";
      case "prompt":
        return "User prompt";
      case "session_start":
        return "Session start";
      default:
        return type;
    }
  }
}

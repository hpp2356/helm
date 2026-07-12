import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  Checkpoint,
  CheckpointIndexEntry,
  CheckpointStoreOptions,
  FileSnapshot,
} from "./types.js";

// ── Checkpoint Store ─────────────────────────────────────────────────────
// Persists checkpoints to ~/.helm/checkpoints/<session-id>/*.json
// Maintains an index.json for fast listing.

export class CheckpointStore {
  private baseDir: string;
  private retentionDays: number;

  constructor(opts: CheckpointStoreOptions = {}) {
    this.baseDir =
      opts.checkpointDir ??
      path.join(process.env.HOME ?? "/tmp", ".helm", "checkpoints");
    this.retentionDays = opts.retentionDays ?? 30;
  }

  // ── Directory helpers ──────────────────────────────────────────────────

  private sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }

  private indexPath(): string {
    return path.join(this.baseDir, "index.json");
  }

  private checkpointPath(sessionId: string, checkpointId: string): string {
    return path.join(this.sessionDir(sessionId), `${checkpointId}.json`);
  }

  // ── Index management ───────────────────────────────────────────────────

  private readIndex(): CheckpointIndexEntry[] {
    try {
      const raw = fs.readFileSync(this.indexPath(), "utf-8");
      return JSON.parse(raw) as CheckpointIndexEntry[];
    } catch {
      return [];
    }
  }

  private writeIndex(entries: CheckpointIndexEntry[]): void {
    const dir = path.dirname(this.indexPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(entries, null, 2), "utf-8");
  }

  private addToIndex(entry: CheckpointIndexEntry): void {
    const entries = this.readIndex();
    entries.push(entry);
    this.writeIndex(entries);
  }

  private removeFromIndex(checkpointId: string): void {
    const entries = this.readIndex().filter((e) => e.id !== checkpointId);
    this.writeIndex(entries);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────

  save(checkpoint: Checkpoint): void {
    const dir = this.sessionDir(checkpoint.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = this.checkpointPath(checkpoint.sessionId, checkpoint.id);
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
    this.addToIndex({
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      timestamp: checkpoint.timestamp,
      type: checkpoint.type,
      fileCount: checkpoint.files.length,
      conversationIndex: checkpoint.conversationIndex,
      description: checkpoint.description,
    });
  }

  load(sessionId: string, checkpointId: string): Checkpoint | null {
    const filePath = this.checkpointPath(sessionId, checkpointId);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  list(sessionId?: string): CheckpointIndexEntry[] {
    const entries = this.readIndex();
    if (sessionId) {
      return entries.filter((e) => e.sessionId === sessionId);
    }
    return entries;
  }

  delete(sessionId: string, checkpointId: string): boolean {
    const filePath = this.checkpointPath(sessionId, checkpointId);
    try {
      fs.unlinkSync(filePath);
      this.removeFromIndex(checkpointId);
      return true;
    } catch {
      return false;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  clean(): number {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const entries = this.readIndex();
    const expired = entries.filter((e) => e.timestamp < cutoff);
    let removed = 0;

    for (const entry of expired) {
      if (this.delete(entry.sessionId, entry.id)) {
        removed++;
      }
    }

    // Clean empty session directories
    try {
      const sessionDirs = fs.readdirSync(this.baseDir, { withFileTypes: true });
      for (const d of sessionDirs) {
        if (d.isDirectory()) {
          const sessionPath = path.join(this.baseDir, d.name);
          const contents = fs.readdirSync(sessionPath);
          if (contents.length === 0) {
            fs.rmdirSync(sessionPath);
          }
        }
      }
    } catch {
      // non-fatal
    }

    return removed;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  static hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  snapshotFile(filePath: string): FileSnapshot | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return {
        path: filePath,
        content,
        hash: CheckpointStore.hashContent(content),
      };
    } catch {
      return null;
    }
  }
}

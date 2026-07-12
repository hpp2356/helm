// ── Checkpoint Types ──────────────────────────────────────────────────────

export type CheckpointType = "file_edit" | "prompt" | "session_start";

export type RestoreAction =
  | "code+conversation"
  | "conversation"
  | "code"
  | "summarize_from"
  | "summarize_up_to";

export interface FileSnapshot {
  path: string;
  content: string;
  hash: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  timestamp: number;
  type: CheckpointType;
  files: FileSnapshot[];
  conversationIndex: number;
  promptText?: string;
  description?: string;
}

export interface CheckpointIndexEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  type: CheckpointType;
  fileCount: number;
  conversationIndex: number;
  description?: string;
}

export interface CheckpointSummary {
  id: string;
  summaryText: string;
  messageCountBefore: number;
  messageCountAfter: number;
}

export interface CheckpointStoreOptions {
  checkpointDir?: string;
  retentionDays?: number;
}

export interface CheckpointManagerOptions {
  sessionId: string;
  checkpointDir?: string;
  retentionDays?: number;
  enabled?: boolean;
  /** Maximum file size in bytes to snapshot (default 1MB). */
  maxFileSize?: number;
}

export interface RestoreResult {
  action: RestoreAction;
  checkpointId: string;
  filesRestored: string[];
  conversationIndex: number;
}

export interface CheckpointListEntry {
  id: string;
  type: CheckpointType;
  timestamp: number;
  description: string;
  fileCount: number;
  conversationIndex: number;
}

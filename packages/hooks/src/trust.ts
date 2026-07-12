// packages/hooks/src/trust.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { TrustEntry } from "./types.js";

/**
 * Trust registry for hook commands.
 *
 * Stores trust entries in ~/.helm/trust.json.
 * Trust is based on command path + file content hash.
 */
export class TrustRegistry {
  private entries: Map<string, TrustEntry> = new Map();
  private filePath: string;

  constructor(homeDir?: string) {
    const home = homeDir ?? process.env.HOME ?? "/tmp";
    this.filePath = resolve(home, ".helm", "trust.json");
    this.load();
  }

  /** Check if a command is trusted (path + hash match). */
  isTrusted(command: string): boolean {
    const entry = this.entries.get(command);
    if (!entry || !entry.trusted) return false;

    // Verify hash hasn't changed
    const currentHash = hashCommand(command);
    return entry.hash === currentHash;
  }

  /** Trust a command. Records path + content hash. */
  trust(command: string): void {
    const hash = hashCommand(command);
    this.entries.set(command, {
      command,
      hash,
      trusted: true,
      trustedAt: new Date().toISOString(),
    });
    this.save();
  }

  /** Revoke trust for a command. */
  untrust(command: string): void {
    const existing = this.entries.get(command);
    if (existing) {
      existing.trusted = false;
      this.save();
    }
  }

  /** List all trust entries. */
  list(): TrustEntry[] {
    return [...this.entries.values()];
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const entries = JSON.parse(content) as TrustEntry[];
      for (const entry of entries) {
        if (entry.command && typeof entry.trusted === "boolean") {
          this.entries.set(entry.command, entry);
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const entries = [...this.entries.values()];
      writeFileSync(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
    } catch {
      // Non-fatal — trust just won't persist
    }
  }
}

/**
 * Hash a command file's content for trust verification.
 * Falls back to hashing the command string itself if file not found.
 */
export function hashCommand(command: string): string {
  const hash = createHash("sha256");

  // Try to read the command as a file path
  try {
    const content = readFileSync(command, "utf-8");
    hash.update(content);
  } catch {
    // Not a file — hash the command string itself
    hash.update(command);
  }

  return hash.digest("hex").slice(0, 16);
}

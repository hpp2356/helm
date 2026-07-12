// packages/usage/src/storage.ts

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { UsageRecord, UsageStats } from "./types.js";

/**
 * Usage storage — writes usage records to JSONL files.
 *
 * File layout:
 *   ~/.helm/usage/YYYY-MM-DD.jsonl  — daily usage records
 */
export class UsageStorage {
  private dir: string;

  constructor(dir?: string) {
    const home = process.env.HOME ?? "/tmp";
    this.dir = dir ?? join(home, ".helm", "usage");
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }
    } catch {
      // Non-fatal
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Write a usage record to today's file. */
  record(entry: UsageRecord): void {
    try {
      const path = join(this.dir, `${this.today()}.jsonl`);
      appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Non-fatal
    }
  }

  /** Load all usage records for a specific date. */
  loadDay(date: string): UsageRecord[] {
    try {
      const path = join(this.dir, `${date}.jsonl`);
      const content = readFileSync(path, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as UsageRecord);
    } catch {
      return [];
    }
  }

  /** Load usage records for today. */
  loadToday(): UsageRecord[] {
    return this.loadDay(this.today());
  }

  /** Aggregate usage stats for a set of records. */
  aggregate(records: UsageRecord[]): UsageStats {
    if (records.length === 0) {
      return {
        sessions: 0,
        total_input_tokens: 0,
        total_cached_tokens: 0,
        total_output_tokens: 0,
        total_reasoning_tokens: 0,
        total_cost: 0,
        period_start: new Date().toISOString(),
        period_end: new Date().toISOString(),
      };
    }

    const stats: UsageStats = {
      sessions: records.length,
      total_input_tokens: 0,
      total_cached_tokens: 0,
      total_output_tokens: 0,
      total_reasoning_tokens: 0,
      total_cost: 0,
      period_start: records[0]!.timestamp,
      period_end: records[records.length - 1]!.timestamp,
    };

    for (const r of records) {
      stats.total_input_tokens += r.tokens.input_tokens;
      stats.total_cached_tokens += r.tokens.cached_tokens;
      stats.total_output_tokens += r.tokens.output_tokens;
      stats.total_reasoning_tokens += r.tokens.reasoning_tokens;
      stats.total_cost += r.cost.total_cost;
    }

    return stats;
  }

  /** Get daily stats for today. */
  getDailyStats(): UsageStats {
    return this.aggregate(this.loadToday());
  }

  /** Get monthly stats (all records for current month). */
  getMonthlyStats(): UsageStats {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `${year}-${month}`;

    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const files = readdirSync(this.dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));

      let allRecords: UsageRecord[] = [];
      for (const file of files) {
        const records = this.loadDay(file.replace(".jsonl", ""));
        allRecords = allRecords.concat(records);
      }

      return this.aggregate(allRecords);
    } catch {
      return this.aggregate([]);
    }
  }
}

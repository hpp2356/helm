// packages/usage/src/storage.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageStorage } from "./storage.js";
import type { UsageRecord } from "./types.js";

const SAMPLE_RECORD: UsageRecord = {
  session_id: "test-123",
  timestamp: "2026-07-12T10:00:00Z",
  model: "deepseek-chat",
  provider: "deepseek",
  tokens: {
    input_tokens: 1000,
    cached_tokens: 500,
    output_tokens: 500,
    reasoning_tokens: 0,
  },
  cost: {
    input_cost: 0.00007,
    cached_cost: 0.000035,
    output_cost: 0.00014,
    reasoning_cost: 0,
    total_cost: 0.000245,
  },
  duration_ms: 5000,
};

describe("UsageStorage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-usage-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates directory on construction", () => {
    const storage = new UsageStorage(join(tempDir, "usage"));
    // Directory should exist
    storage.record(SAMPLE_RECORD);
    const records = storage.loadToday();
    expect(records.length).toBeGreaterThan(0);
  });

  it("records and loads usage", () => {
    const storage = new UsageStorage(tempDir);
    storage.record(SAMPLE_RECORD);

    const records = storage.loadToday();
    expect(records).toHaveLength(1);
    expect(records[0]!.session_id).toBe("test-123");
    expect(records[0]!.cost.total_cost).toBe(0.000245);
  });

  it("appends multiple records", () => {
    const storage = new UsageStorage(tempDir);
    storage.record(SAMPLE_RECORD);
    storage.record({ ...SAMPLE_RECORD, session_id: "test-456" });

    const records = storage.loadToday();
    expect(records).toHaveLength(2);
  });

  it("aggregates stats correctly", () => {
    const storage = new UsageStorage(tempDir);
    storage.record(SAMPLE_RECORD);
    storage.record({
      ...SAMPLE_RECORD,
      session_id: "test-456",
      tokens: { input_tokens: 2000, cached_tokens: 0, output_tokens: 1000, reasoning_tokens: 0 },
      cost: { input_cost: 0.00028, cached_cost: 0, output_cost: 0.00028, reasoning_cost: 0, total_cost: 0.00056 },
    });

    const stats = storage.getDailyStats();
    expect(stats.sessions).toBe(2);
    expect(stats.total_input_tokens).toBe(3000);
    expect(stats.total_output_tokens).toBe(1500);
    expect(stats.total_cost).toBeCloseTo(0.000805, 6);
  });

  it("returns empty stats for no records", () => {
    const storage = new UsageStorage(tempDir);
    const stats = storage.getDailyStats();
    expect(stats.sessions).toBe(0);
    expect(stats.total_cost).toBe(0);
  });
});

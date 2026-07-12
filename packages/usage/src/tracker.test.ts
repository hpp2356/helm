// packages/usage/src/tracker.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageTracker } from "./tracker.js";
import type { BudgetConfig, PriceTable } from "./types.js";

const TEST_PRICES: PriceTable = {
  deepseek: {
    "deepseek-chat": { input: 0.14, cached: 0.07, output: 0.28 },
  },
};

const TEST_BUDGET: BudgetConfig = {
  session_limit: 1.0,
  daily_limit: 10.0,
  warning_threshold: 0.8,
};

describe("UsageTracker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-tracker-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records tokens and calculates cost", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
    });

    tracker.recordTokens({
      input_tokens: 1000,
      cached_tokens: 500,
      output_tokens: 500,
      reasoning_tokens: 0,
    });

    const tokens = tracker.getSessionTokens();
    expect(tokens.input_tokens).toBe(1000);
    expect(tokens.cached_tokens).toBe(500);
    expect(tokens.output_tokens).toBe(500);

    const cost = tracker.getSessionCost();
    expect(cost.total_cost).toBeGreaterThan(0);
  });

  it("accumulates tokens across calls", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
    });

    tracker.recordTokens({ input_tokens: 100, cached_tokens: 0, output_tokens: 50, reasoning_tokens: 0 });
    tracker.recordTokens({ input_tokens: 200, cached_tokens: 100, output_tokens: 100, reasoning_tokens: 0 });

    const tokens = tracker.getSessionTokens();
    expect(tokens.input_tokens).toBe(300);
    expect(tokens.cached_tokens).toBe(100);
    expect(tokens.output_tokens).toBe(150);
  });

  it("checks budget correctly", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      budgetConfig: TEST_BUDGET,
      storageDir: tempDir,
    });

    // Under budget
    tracker.recordTokens({ input_tokens: 100, cached_tokens: 0, output_tokens: 100, reasoning_tokens: 0 });
    const result = tracker.checkBudget();
    expect(result.ok).toBe(true);
  });

  it("saves session to storage", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
    });

    tracker.recordTokens({ input_tokens: 100, cached_tokens: 0, output_tokens: 50, reasoning_tokens: 0 });
    tracker.saveSession();

    const stats = tracker.getDailyStats();
    expect(stats.sessions).toBe(1);
    expect(stats.total_input_tokens).toBe(100);
  });

  it("formats session status", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
    });

    tracker.recordTokens({ input_tokens: 1234, cached_tokens: 567, output_tokens: 2345, reasoning_tokens: 0 });
    const status = tracker.formatSessionStatus();

    expect(status).toContain("deepseek-chat");
    expect(status).toContain("1234");
    expect(status).toContain("2345");
  });

  it("formats daily status", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      budgetConfig: TEST_BUDGET,
      storageDir: tempDir,
    });

    const status = tracker.formatDailyStatus();
    expect(status).toContain("Daily Usage");
  });

  it("respects enabled flag", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
      enabled: false,
    });

    tracker.recordTokens({ input_tokens: 100, cached_tokens: 0, output_tokens: 50, reasoning_tokens: 0 });

    // Should not record anything
    const tokens = tracker.getSessionTokens();
    expect(tokens.input_tokens).toBe(0);
  });

  it("tracks session duration", () => {
    const tracker = new UsageTracker("deepseek", "deepseek-chat", {
      priceTable: TEST_PRICES,
      storageDir: tempDir,
    });

    const duration = tracker.getSessionDurationMs();
    expect(duration).toBeGreaterThanOrEqual(0);
  });
});

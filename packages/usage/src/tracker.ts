// packages/usage/src/tracker.ts

import type { TokenUsage, CostBreakdown, BudgetConfig, BudgetCheckResult, UsageRecord, PriceTable, ModelPrice } from "./types.js";
import { calculateCost } from "./cost.js";
import { lookupPrice, loadPriceTable } from "./prices.js";
import { checkBudget, loadBudgetConfig } from "./budget.js";
import { UsageStorage } from "./storage.js";

/** Options for creating a UsageTracker. */
export interface UsageTrackerOptions {
  /** Price table (loaded from file if not provided). */
  priceTable?: PriceTable;
  /** Budget configuration. */
  budgetConfig?: BudgetConfig;
  /** Usage storage directory. */
  storageDir?: string;
  /** Whether cost tracking is enabled. */
  enabled?: boolean;
}

/**
 * UsageTracker — tracks token usage, calculates costs, checks budgets.
 *
 * Usage:
 *   const tracker = new UsageTracker({ provider: 'deepseek', model: 'deepseek-chat' });
 *   tracker.recordTokens({ input_tokens: 100, cached_tokens: 50, output_tokens: 200 });
 *   console.log(tracker.formatStatus());
 */
export class UsageTracker {
  private provider: string;
  private model: string;
  private priceTable: PriceTable;
  private budgetConfig: BudgetConfig;
  private storage: UsageStorage;
  private enabled: boolean;

  /** Session start time. */
  private startTime: Date;
  /** Current session tokens. */
  private sessionTokens: TokenUsage = {
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
  };
  /** Current session cost. */
  private sessionCost: CostBreakdown = {
    input_cost: 0,
    cached_cost: 0,
    output_cost: 0,
    reasoning_cost: 0,
    total_cost: 0,
  };
  /** Session ID. */
  private sessionId: string;

  constructor(
    provider: string,
    model: string,
    options: UsageTrackerOptions = {},
  ) {
    this.provider = provider;
    this.model = model;
    this.priceTable = options.priceTable ?? loadPriceTable();
    this.budgetConfig = options.budgetConfig ?? loadBudgetConfig();
    this.storage = new UsageStorage(options.storageDir);
    this.enabled = options.enabled !== false;
    this.startTime = new Date();
    this.sessionId = `session-${Date.now()}`;
  }

  /** Get current price for this tracker's model. */
  getPrice(): ModelPrice {
    return lookupPrice(this.priceTable, this.provider, this.model);
  }

  /** Record token usage from an API response. */
  recordTokens(tokens: TokenUsage): void {
    if (!this.enabled) return;

    this.sessionTokens.input_tokens += tokens.input_tokens;
    this.sessionTokens.cached_tokens += tokens.cached_tokens;
    this.sessionTokens.output_tokens += tokens.output_tokens;
    this.sessionTokens.reasoning_tokens += tokens.reasoning_tokens;

    // Recalculate cost
    const price = this.getPrice();
    this.sessionCost = calculateCost(this.sessionTokens, price);
  }

  /** Get current session tokens. */
  getSessionTokens(): TokenUsage {
    return { ...this.sessionTokens };
  }

  /** Get current session cost. */
  getSessionCost(): CostBreakdown {
    return { ...this.sessionCost };
  }

  /** Get session duration in milliseconds. */
  getSessionDurationMs(): number {
    return Date.now() - this.startTime.getTime();
  }

  /** Check if current cost is within budget. */
  checkBudget(): BudgetCheckResult {
    const dailyStats = this.storage.getDailyStats();
    const monthlyStats = this.storage.getMonthlyStats();

    return checkBudget(
      this.budgetConfig,
      this.sessionCost.total_cost,
      dailyStats.total_cost + this.sessionCost.total_cost,
      monthlyStats.total_cost + this.sessionCost.total_cost,
    );
  }

  /** Save current session to storage. */
  saveSession(): void {
    if (!this.enabled) return;

    const record: UsageRecord = {
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      model: this.model,
      provider: this.provider,
      tokens: { ...this.sessionTokens },
      cost: { ...this.sessionCost },
      duration_ms: this.getSessionDurationMs(),
    };

    this.storage.record(record);
  }

  /** Format session status for display. */
  formatSessionStatus(): string {
    const tokens = this.sessionTokens;
    const cost = this.sessionCost;
    const duration = this.getSessionDurationMs();

    const lines = [
      "╭─ Session Usage ─────────────────────────────╮",
      `│ Model:         ${this.model.padEnd(28)} │`,
      `│ Input tokens:  ${String(tokens.input_tokens).padStart(12)} (cached: ${String(tokens.cached_tokens).padStart(8)}) │`,
      `│ Output tokens: ${String(tokens.output_tokens).padStart(28)} │`,
      `│ Total cost:    ${("$" + cost.total_cost.toFixed(6)).padEnd(28)} │`,
      `│ Duration:      ${formatDuration(duration).padEnd(28)} │`,
      "╰──────────────────────────────────────────────╯",
    ];

    return lines.join("\n");
  }

  /** Format daily status for display. */
  formatDailyStatus(): string {
    const stats = this.storage.getDailyStats();
    const budget = this.checkBudget();

    const budgetInfo = this.budgetConfig.daily_limit
      ? `$${this.budgetConfig.daily_limit.toFixed(2)} (${(budget.ratio * 100).toFixed(1)}% used)`
      : "No limit";

    const lines = [
      "╭─ Daily Usage ───────────────────────────────╮",
      `│ Sessions:    ${String(stats.sessions).padStart(32)} │`,
      `│ Total cost:  ${("$" + stats.total_cost.toFixed(4)).padEnd(32)} │`,
      `│ Budget:      ${budgetInfo.padEnd(32)} │`,
      "╰──────────────────────────────────────────────╯",
    ];

    return lines.join("\n");
  }

  /** Get daily stats. */
  getDailyStats() {
    return this.storage.getDailyStats();
  }

  /** Get monthly stats. */
  getMonthlyStats() {
    return this.storage.getMonthlyStats();
  }
}

/** Format duration in ms to human readable. */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

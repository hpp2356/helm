// packages/usage/src/types.ts

/** Token usage breakdown. */
export interface TokenUsage {
  /** Total input tokens. */
  input_tokens: number;
  /** Cached input tokens (have discount). */
  cached_tokens: number;
  /** Output tokens. */
  output_tokens: number;
  /** Reasoning/thinking tokens (hidden cost). */
  reasoning_tokens: number;
}

/** Cost breakdown for a request or session. */
export interface CostBreakdown {
  /** Input token cost. */
  input_cost: number;
  /** Cached token cost (with discount). */
  cached_cost: number;
  /** Output token cost. */
  output_cost: number;
  /** Reasoning token cost. */
  reasoning_cost: number;
  /** Total cost in USD. */
  total_cost: number;
}

/** Price per million tokens for a model. */
export interface ModelPrice {
  /** Price per 1M input tokens. */
  input: number;
  /** Price per 1M cached input tokens. */
  cached: number;
  /** Price per 1M output tokens. */
  output: number;
}

/** Price table: provider -> model -> price. */
export type PriceTable = Record<string, Record<string, ModelPrice>>;

/** Budget configuration. */
export interface BudgetConfig {
  /** Single session limit (USD). */
  session_limit?: number;
  /** Daily limit (USD). */
  daily_limit?: number;
  /** Monthly limit (USD). */
  monthly_limit?: number;
  /** Warning threshold (0-1, default 0.8 = 80%). */
  warning_threshold: number;
}

/** Budget check result. */
export interface BudgetCheckResult {
  /** Whether budget is OK. */
  ok: boolean;
  /** Whether this is a warning (not exceeded). */
  warning: boolean;
  /** Human-readable message. */
  message: string;
  /** Current cost. */
  current_cost: number;
  /** Limit that was checked. */
  limit: number;
  /** Usage ratio (0-1+). */
  ratio: number;
}

/** Single usage record for storage. */
export interface UsageRecord {
  /** Session ID. */
  session_id: string;
  /** Timestamp. */
  timestamp: string;
  /** Model name. */
  model: string;
  /** Provider name. */
  provider: string;
  /** Token usage. */
  tokens: TokenUsage;
  /** Cost breakdown. */
  cost: CostBreakdown;
  /** Duration in milliseconds. */
  duration_ms: number;
}

/** Aggregated usage stats. */
export interface UsageStats {
  /** Number of sessions. */
  sessions: number;
  /** Total input tokens. */
  total_input_tokens: number;
  /** Total cached tokens. */
  total_cached_tokens: number;
  /** Total output tokens. */
  total_output_tokens: number;
  /** Total reasoning tokens. */
  total_reasoning_tokens: number;
  /** Total cost in USD. */
  total_cost: number;
  /** Period start. */
  period_start: string;
  /** Period end. */
  period_end: string;
}

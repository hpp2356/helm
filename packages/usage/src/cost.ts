// packages/usage/src/cost.ts

import type { TokenUsage, CostBreakdown, ModelPrice } from "./types.js";

/**
 * Calculate cost from token usage and price.
 *
 * Formula:
 *   cost = (input_tokens - cached_tokens) * price_input
 *        + cached_tokens * price_input * cache_discount
 *        + output_tokens * price_output
 *        + reasoning_tokens * price_output
 *
 * Prices are per 1M tokens. Cache discount is the ratio of cached price to input price.
 */
export function calculateCost(tokens: TokenUsage, price: ModelPrice): CostBreakdown {
  const nonCachedInput = Math.max(0, tokens.input_tokens - tokens.cached_tokens);

  const input_cost = (nonCachedInput / 1_000_000) * price.input;
  const cached_cost = (tokens.cached_tokens / 1_000_000) * price.cached;
  const output_cost = (tokens.output_tokens / 1_000_000) * price.output;
  const reasoning_cost = (tokens.reasoning_tokens / 1_000_000) * price.output;

  const total_cost = input_cost + cached_cost + output_cost + reasoning_cost;

  return {
    input_cost: roundCost(input_cost),
    cached_cost: roundCost(cached_cost),
    output_cost: roundCost(output_cost),
    reasoning_cost: roundCost(reasoning_cost),
    total_cost: roundCost(total_cost),
  };
}

/** Round cost to 6 decimal places. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Format cost as USD string. */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(6)}`;
  }
  if (cost < 1.0) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/** Format token count with commas. */
export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}

// packages/usage/src/prices.ts

import { readFileSync } from "node:fs";
import type { PriceTable, ModelPrice } from "./types.js";

/** Default price table (per 1M tokens). */
export const DEFAULT_PRICES: PriceTable = {
  deepseek: {
    "deepseek-chat": { input: 0.14, cached: 0.07, output: 0.28 },
    "deepseek-reasoner": { input: 0.55, cached: 0.28, output: 2.19 },
  },
  anthropic: {
    "claude-sonnet-4": { input: 3.0, cached: 1.5, output: 15.0 },
    "claude-opus-4": { input: 15.0, cached: 7.5, output: 75.0 },
    "claude-haiku-4": { input: 0.25, cached: 0.125, output: 1.25 },
  },
  openai: {
    "gpt-4.1": { input: 2.5, cached: 1.25, output: 10.0 },
    "gpt-4.1-mini": { input: 0.4, cached: 0.2, output: 1.6 },
    "gpt-4o": { input: 2.5, cached: 1.25, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  },
};

/**
 * Load price table, merging custom prices over defaults.
 *
 * Custom prices file location:
 *   - HELM_PRICES_FILE env var
 *   - ~/.helm/prices.json
 */
export function loadPriceTable(customPath?: string): PriceTable {
  const table = structuredClone(DEFAULT_PRICES);

  const path = customPath ?? process.env.HELM_PRICES_FILE ?? `${process.env.HOME ?? "/tmp"}/.helm/prices.json`;

  try {
    const content = readFileSync(path, "utf-8");
    const custom = JSON.parse(content) as Record<string, Record<string, { input?: number; cached?: number; output?: number }>>;

    for (const [provider, models] of Object.entries(custom)) {
      if (!table[provider]) table[provider] = {};
      for (const [model, price] of Object.entries(models)) {
        table[provider]![model] = {
          input: price.input ?? 0,
          cached: price.cached ?? price.input ?? 0,
          output: price.output ?? 0,
        };
      }
    }
  } catch {
    // File missing or invalid — use defaults
  }

  return table;
}

/**
 * Look up price for a provider/model.
 * Falls back to a generic default if not found.
 */
export function lookupPrice(table: PriceTable, provider: string, model: string): ModelPrice {
  return table[provider]?.[model] ?? { input: 0.14, cached: 0.07, output: 0.28 };
}

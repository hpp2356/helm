// packages/usage/src/prices.test.ts

import { describe, it, expect } from "vitest";
import { loadPriceTable, lookupPrice, DEFAULT_PRICES } from "./prices.js";

describe("loadPriceTable", () => {
  it("returns default prices when no custom file", () => {
    const table = loadPriceTable("/nonexistent/path.json");
    expect(table.deepseek?.["deepseek-chat"]).toBeDefined();
    expect(table.anthropic?.["claude-sonnet-4"]).toBeDefined();
    expect(table.openai?.["gpt-4.1"]).toBeDefined();
  });

  it("has correct default values", () => {
    expect(DEFAULT_PRICES.deepseek?.["deepseek-chat"]?.input).toBe(0.14);
    expect(DEFAULT_PRICES.anthropic?.["claude-sonnet-4"]?.output).toBe(15.0);
  });
});

describe("lookupPrice", () => {
  it("finds known model", () => {
    const price = lookupPrice(DEFAULT_PRICES, "deepseek", "deepseek-chat");
    expect(price.input).toBe(0.14);
    expect(price.cached).toBe(0.07);
    expect(price.output).toBe(0.28);
  });

  it("returns fallback for unknown model", () => {
    const price = lookupPrice(DEFAULT_PRICES, "unknown", "unknown-model");
    expect(price.input).toBe(0.14); // fallback
  });

  it("returns fallback for unknown provider", () => {
    const price = lookupPrice(DEFAULT_PRICES, "no-provider", "no-model");
    expect(price.input).toBe(0.14);
  });
});

// packages/usage/src/cost.test.ts

import { describe, it, expect } from "vitest";
import { calculateCost, formatCost, formatTokens } from "./cost.js";
import type { TokenUsage, ModelPrice } from "./types.js";

const DEEPSEEK_PRICE: ModelPrice = { input: 0.14, cached: 0.07, output: 0.28 };

describe("calculateCost", () => {
  it("calculates basic input/output cost", () => {
    const tokens: TokenUsage = {
      input_tokens: 1000,
      cached_tokens: 0,
      output_tokens: 500,
      reasoning_tokens: 0,
    };

    const cost = calculateCost(tokens, DEEPSEEK_PRICE);

    // input: 1000/1M * 0.14 = 0.00014
    // output: 500/1M * 0.28 = 0.00014
    expect(cost.input_cost).toBeCloseTo(0.00014, 6);
    expect(cost.output_cost).toBeCloseTo(0.00014, 6);
    expect(cost.total_cost).toBeCloseTo(0.00028, 6);
  });

  it("applies cache discount", () => {
    const tokens: TokenUsage = {
      input_tokens: 1000,
      cached_tokens: 500,
      output_tokens: 0,
      reasoning_tokens: 0,
    };

    const cost = calculateCost(tokens, DEEPSEEK_PRICE);

    // non-cached input: 500/1M * 0.14 = 0.00007
    // cached: 500/1M * 0.07 = 0.000035
    expect(cost.input_cost).toBeCloseTo(0.00007, 6);
    expect(cost.cached_cost).toBeCloseTo(0.000035, 6);
    expect(cost.total_cost).toBeCloseTo(0.000105, 6);
  });

  it("handles reasoning tokens", () => {
    const tokens: TokenUsage = {
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 100,
      reasoning_tokens: 200,
    };

    const cost = calculateCost(tokens, DEEPSEEK_PRICE);

    // output: 100/1M * 0.28 = 0.000028
    // reasoning: 200/1M * 0.28 = 0.000056
    expect(cost.output_cost).toBeCloseTo(0.000028, 6);
    expect(cost.reasoning_cost).toBeCloseTo(0.000056, 6);
  });

  it("handles zero tokens", () => {
    const tokens: TokenUsage = {
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    };

    const cost = calculateCost(tokens, DEEPSEEK_PRICE);
    expect(cost.total_cost).toBe(0);
  });

  it("handles more cached than input", () => {
    const tokens: TokenUsage = {
      input_tokens: 100,
      cached_tokens: 200,
      output_tokens: 0,
      reasoning_tokens: 0,
    };

    const cost = calculateCost(tokens, DEEPSEEK_PRICE);

    // non-cached input: max(0, 100-200) = 0
    expect(cost.input_cost).toBe(0);
    // cached: 200/1M * 0.07
    expect(cost.cached_cost).toBeCloseTo(0.000014, 6);
  });
});

describe("formatCost", () => {
  it("formats small costs with 6 decimals", () => {
    expect(formatCost(0.000123)).toBe("$0.000123");
  });

  it("formats medium costs with 4 decimals", () => {
    expect(formatCost(0.1234)).toBe("$0.1234");
  });

  it("formats large costs with 2 decimals", () => {
    expect(formatCost(12.34)).toBe("$12.34");
  });
});

describe("formatTokens", () => {
  it("formats with commas", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
  });

  it("handles small numbers", () => {
    expect(formatTokens(42)).toBe("42");
  });
});

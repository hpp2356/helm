import { describe, it, expect } from "vitest";
import { TokenBudget } from "./context.js";

describe("TokenBudget", () => {
  it("tracks initial state", () => {
    const budget = new TokenBudget(1000);
    expect(budget.maxTokens).toBe(1000);
    expect(budget.usedTokens).toBe(0);
    expect(budget.remainingTokens).toBe(1000);
    expect(budget.isExhausted()).toBe(false);
  });

  it("tracks usage and reports remaining", () => {
    const budget = new TokenBudget(1000);
    budget.consume(300);
    expect(budget.usedTokens).toBe(300);
    expect(budget.remainingTokens).toBe(700);
    expect(budget.isExhausted()).toBe(false);
  });

  it("detects exhaustion when used reaches max", () => {
    const budget = new TokenBudget(1000);
    budget.consume(1000);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.remainingTokens).toBe(0);
  });

  it("detects exhaustion when used exceeds max", () => {
    const budget = new TokenBudget(1000);
    budget.consume(1001);
    expect(budget.isExhausted()).toBe(true);
  });

  it("fires warning at configured threshold (default 80%)", () => {
    const budget = new TokenBudget(1000);
    budget.consume(799);
    expect(budget.isWarning()).toBe(false);
    budget.consume(1); // 800
    expect(budget.isWarning()).toBe(true);
  });

  it("fires warning at custom threshold", () => {
    const budget = new TokenBudget(1000, 0.5);
    budget.consume(499);
    expect(budget.isWarning()).toBe(false);
    budget.consume(1); // 500
    expect(budget.isWarning()).toBe(true);
  });

  it("supports reset", () => {
    const budget = new TokenBudget(1000);
    budget.consume(500);
    budget.reset();
    expect(budget.usedTokens).toBe(0);
    expect(budget.remainingTokens).toBe(1000);
    expect(budget.isExhausted()).toBe(false);
  });

  it("throws on non-positive maxTokens", () => {
    expect(() => new TokenBudget(0)).toThrow("must be positive");
    expect(() => new TokenBudget(-1)).toThrow("must be positive");
  });

  it("remainingTokens floors at zero", () => {
    const budget = new TokenBudget(100);
    budget.consume(150);
    expect(budget.remainingTokens).toBe(0);
  });
});

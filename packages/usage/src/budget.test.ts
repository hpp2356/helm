// packages/usage/src/budget.test.ts

import { describe, it, expect } from "vitest";
import { checkBudget, loadBudgetConfig } from "./budget.js";
import type { BudgetConfig } from "./types.js";

const CONFIG: BudgetConfig = {
  session_limit: 1.0,
  daily_limit: 10.0,
  monthly_limit: 100.0,
  warning_threshold: 0.8,
};

describe("checkBudget", () => {
  it("returns ok when under budget", () => {
    const result = checkBudget(CONFIG, 0.5, 5.0, 50.0);
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(false);
  });

  it("returns warning at threshold", () => {
    const result = checkBudget(CONFIG, 0.85, 5.0, 50.0);
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(true);
    expect(result.message).toContain("warning");
  });

  it("returns exceeded when over session limit", () => {
    const result = checkBudget(CONFIG, 1.1, 5.0, 50.0);
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(false);
    expect(result.message).toContain("exceeded");
  });

  it("returns exceeded when over daily limit", () => {
    const result = checkBudget(CONFIG, 0.5, 11.0, 50.0);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Daily");
  });

  it("returns exceeded when over monthly limit", () => {
    const result = checkBudget(CONFIG, 0.5, 5.0, 110.0);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Monthly");
  });

  it("monthly takes precedence over daily", () => {
    const result = checkBudget(CONFIG, 0.5, 11.0, 110.0);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Monthly");
  });

  it("handles no limits", () => {
    const config: BudgetConfig = { warning_threshold: 0.8 };
    const result = checkBudget(config, 999, 999, 999);
    expect(result.ok).toBe(true);
  });

  it("calculates ratio correctly", () => {
    const result = checkBudget(CONFIG, 0.5, 5.0, 50.0);
    expect(result.ratio).toBe(0.5);
  });
});

describe("loadBudgetConfig", () => {
  it("loads from env vars", () => {
    const config = loadBudgetConfig({
      HELM_BUDGET_SESSION: "2.5",
      HELM_BUDGET_DAILY: "25",
      HELM_BUDGET_MONTHLY: "250",
      HELM_BUDGET_WARNING: "0.9",
    });
    expect(config.session_limit).toBe(2.5);
    expect(config.daily_limit).toBe(25);
    expect(config.monthly_limit).toBe(250);
    expect(config.warning_threshold).toBe(0.9);
  });

  it("uses defaults when env vars missing", () => {
    const config = loadBudgetConfig({});
    expect(config.session_limit).toBeUndefined();
    expect(config.warning_threshold).toBe(0.8);
  });
});

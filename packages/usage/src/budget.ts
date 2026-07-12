// packages/usage/src/budget.ts

import type { BudgetConfig, BudgetCheckResult } from "./types.js";

/** Default budget configuration. */
export const DEFAULT_BUDGET: BudgetConfig = {
  warning_threshold: 0.8,
};

/**
 * Check if a cost is within budget.
 *
 * @param currentCost - Current accumulated cost
 * @param limit - Budget limit (undefined = no limit)
 * @param threshold - Warning threshold (0-1)
 * @returns Check result
 */
function checkLimit(
  currentCost: number,
  limit: number | undefined,
  threshold: number,
  label: string,
): BudgetCheckResult | null {
  if (limit === undefined) return null;

  const ratio = currentCost / limit;

  if (ratio >= 1.0) {
    return {
      ok: false,
      warning: false,
      message: `${label} budget exceeded: $${currentCost.toFixed(4)} / $${limit.toFixed(2)} (${(ratio * 100).toFixed(1)}%)`,
      current_cost: currentCost,
      limit,
      ratio,
    };
  }

  if (ratio >= threshold) {
    return {
      ok: true,
      warning: true,
      message: `${label} budget warning: $${currentCost.toFixed(4)} / $${limit.toFixed(2)} (${(ratio * 100).toFixed(1)}%)`,
      current_cost: currentCost,
      limit,
      ratio,
    };
  }

  return {
    ok: true,
    warning: false,
    message: "",
    current_cost: currentCost,
    limit,
    ratio,
  };
}

/**
 * Check all budget limits.
 * Returns the most severe result (exceeded > warning > ok).
 */
export function checkBudget(
  config: BudgetConfig,
  sessionCost: number,
  dailyCost: number,
  monthlyCost: number,
): BudgetCheckResult {
  const threshold = config.warning_threshold;

  // Check monthly first (highest level)
  const monthly = checkLimit(monthlyCost, config.monthly_limit, threshold, "Monthly");
  if (monthly && !monthly.ok) return monthly;

  // Then daily
  const daily = checkLimit(dailyCost, config.daily_limit, threshold, "Daily");
  if (daily && !daily.ok) return daily;

  // Then session
  const session = checkLimit(sessionCost, config.session_limit, threshold, "Session");
  if (session && !session.ok) return session;

  // Return warnings (if any)
  if (monthly?.warning) return monthly;
  if (daily?.warning) return daily;
  if (session?.warning) return session;

  // All OK
  return {
    ok: true,
    warning: false,
    message: "",
    current_cost: sessionCost,
    limit: config.session_limit ?? 0,
    ratio: config.session_limit ? sessionCost / config.session_limit : 0,
  };
}

/**
 * Load budget config from environment variables.
 */
export function loadBudgetConfig(env?: Record<string, string | undefined>): BudgetConfig {
  const envVars = env ?? process.env;
  const sessionLimit = envVars.HELM_BUDGET_SESSION
    ? parseFloat(envVars.HELM_BUDGET_SESSION)
    : undefined;
  const dailyLimit = envVars.HELM_BUDGET_DAILY
    ? parseFloat(envVars.HELM_BUDGET_DAILY)
    : undefined;
  const monthlyLimit = envVars.HELM_BUDGET_MONTHLY
    ? parseFloat(envVars.HELM_BUDGET_MONTHLY)
    : undefined;
  const warningThreshold = envVars.HELM_BUDGET_WARNING
    ? parseFloat(envVars.HELM_BUDGET_WARNING)
    : 0.8;

  return {
    session_limit: sessionLimit,
    daily_limit: dailyLimit,
    monthly_limit: monthlyLimit,
    warning_threshold: warningThreshold,
  };
}

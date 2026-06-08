import type { RiskLevel } from "./permission.js";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Risk level for non-interactive policy decisions. */
  riskLevel?: RiskLevel;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

import { describe, it, expect } from "vitest";
import { RiskLevel } from "./permission.js";

describe("RiskLevel", () => {
  it("has four levels", () => {
    expect(RiskLevel.LOW).toBe("LOW");
    expect(RiskLevel.MEDIUM).toBe("MEDIUM");
    expect(RiskLevel.HIGH).toBe("HIGH");
    expect(RiskLevel.CRITICAL).toBe("CRITICAL");
  });
});

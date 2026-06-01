import { describe, it, expect } from "vitest";
import { eventToString, JsonlJournal, type RunEvent } from "./index.js";

describe("@helm/core", () => {
  it("should export eventToString", () => {
    expect(typeof eventToString).toBe("function");
  });

  it("should export JsonlJournal", () => {
    expect(typeof JsonlJournal).toBe("function");
  });

  it("should re-export RunEvent as a type (compile-time check)", () => {
    const event: RunEvent = {
      type: "run:start",
      runId: "test",
      timestamp: 1,
    };
    expect(event.type).toBe("run:start");
  });
});

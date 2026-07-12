// packages/telemetry/src/metrics.test.ts

import { describe, it, expect } from "vitest";
import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector", () => {
  it("increments a counter", () => {
    const mc = new MetricsCollector();
    mc.increment("test.counter", 5, { env: "test" });
    const entries = mc.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("test.counter");
    expect(entries[0]!.type).toBe("counter");
    expect(entries[0]!.value).toBe(5);
    expect(entries[0]!.labels).toEqual({ env: "test" });
  });

  it("records a histogram", () => {
    const mc = new MetricsCollector();
    mc.record("test.duration", 123.4);
    const entries = mc.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("histogram");
    expect(entries[0]!.value).toBe(123.4);
  });

  it("flush clears entries", () => {
    const mc = new MetricsCollector();
    mc.increment("a", 1);
    mc.increment("b", 2);
    expect(mc.flush()).toHaveLength(2);
    expect(mc.flush()).toHaveLength(0);
  });

  it("peek returns entries without clearing", () => {
    const mc = new MetricsCollector();
    mc.increment("a", 1);
    expect(mc.peek()).toHaveLength(1);
    expect(mc.peek()).toHaveLength(1);
  });

  it("clear removes entries", () => {
    const mc = new MetricsCollector();
    mc.increment("a", 1);
    mc.clear();
    expect(mc.peek()).toHaveLength(0);
  });
});

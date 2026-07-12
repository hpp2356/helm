// packages/telemetry/src/logs.test.ts

import { describe, it, expect } from "vitest";
import { LogsCollector } from "./logs.js";

describe("LogsCollector", () => {
  it("records info logs", () => {
    const lc = new LogsCollector();
    lc.info("test:event", "hello", { key: "value" });
    const entries = lc.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.event).toBe("test:event");
    expect(entries[0]!.message).toBe("hello");
    expect(entries[0]!.attributes).toEqual({ key: "value" });
  });

  it("records error logs", () => {
    const lc = new LogsCollector();
    lc.error("test:error", "something broke");
    const entries = lc.flush();
    expect(entries[0]!.level).toBe("error");
  });

  it("skips debug logs in non-verbose mode", () => {
    const lc = new LogsCollector(false);
    lc.debug("test:debug", "hidden");
    expect(lc.flush()).toHaveLength(0);
  });

  it("records debug logs in verbose mode", () => {
    const lc = new LogsCollector(true);
    lc.debug("test:debug", "visible");
    expect(lc.flush()).toHaveLength(1);
  });

  it("flush clears entries", () => {
    const lc = new LogsCollector();
    lc.info("a");
    lc.info("b");
    expect(lc.flush()).toHaveLength(2);
    expect(lc.flush()).toHaveLength(0);
  });
});

// packages/telemetry/src/traces.test.ts

import { describe, it, expect } from "vitest";
import { TracesCollector } from "./traces.js";

describe("TracesCollector", () => {
  it("starts and ends a span", () => {
    const tc = new TracesCollector();
    const { traceId, spanId } = tc.startSpan("test-span");
    expect(traceId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);

    tc.endSpan(spanId, "ok");
    const spans = tc.flush();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("test-span");
    expect(spans[0]!.traceId).toBe(traceId);
    expect(spans[0]!.spanId).toBe(spanId);
    expect(spans[0]!.status).toBe("ok");
    expect(spans[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("creates parent-child spans", () => {
    const tc = new TracesCollector();
    const parent = tc.startSpan("parent");
    const child = tc.startSpan("child", parent.traceId, parent.spanId);

    tc.endSpan(child.spanId);
    tc.endSpan(parent.spanId);

    const spans = tc.flush();
    const childSpan = spans.find((s) => s.name === "child");
    const parentSpan = spans.find((s) => s.name === "parent");
    expect(childSpan!.parentSpanId).toBe(parent.spanId);
    expect(parentSpan!.parentSpanId).toBeUndefined();
  });

  it("records error status", () => {
    const tc = new TracesCollector();
    const { spanId } = tc.startSpan("failing");
    tc.endSpan(spanId, "error", "something broke");

    const spans = tc.flush();
    expect(spans[0]!.status).toBe("error");
    expect(spans[0]!.errorMessage).toBe("something broke");
  });

  it("ignores unknown span IDs", () => {
    const tc = new TracesCollector();
    tc.endSpan("nonexistent");
    expect(tc.flush()).toHaveLength(0);
  });

  it("flush clears spans", () => {
    const tc = new TracesCollector();
    const { spanId } = tc.startSpan("a");
    tc.endSpan(spanId);
    expect(tc.flush()).toHaveLength(1);
    expect(tc.flush()).toHaveLength(0);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  computeDelay,
  delayWithAbort,
  type RetryPolicy,
} from "./retry.js";
import { type AgentError } from "@helm/core";

function makePolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
    jitter: false,
    shouldRetry(e: AgentError) {
      return e.retryable;
    },
    ...overrides,
  };
}

describe("computeDelay", () => {
  it("returns baseDelayMs for attempt 2 (first retry)", () => {
    const p = makePolicy();
    const d = computeDelay(p, 2);
    expect(d).toBe(100);
  });

  it("exponentially grows for later attempts", () => {
    const p = makePolicy();
    expect(computeDelay(p, 3)).toBe(200);  // 100 * 2^1
    expect(computeDelay(p, 4)).toBe(400);  // 100 * 2^2
  });

  it("caps at maxDelayMs", () => {
    const p = makePolicy({ baseDelayMs: 100, maxDelayMs: 250 });
    expect(computeDelay(p, 4)).toBe(250);  // 100 * 2^2 = 400, capped
  });

  it("applies jitter when enabled", () => {
    const p = makePolicy({ jitter: true, baseDelayMs: 200 });
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeDelay(p, 2)).toBe(100); // 200 * 0.5
    spy.mockRestore();
  });
});

describe("RetryPolicy.shouldRetry", () => {
  it("default delegates to error.retryable", () => {
    const p = makePolicy();
    expect(
      p.shouldRetry({
        type: "provider",
        category: "rate_limit",
        message: "x",
        retryable: true,
      }),
    ).toBe(true);
    expect(
      p.shouldRetry({
        type: "provider",
        category: "auth_failure",
        message: "x",
        retryable: false,
      }),
    ).toBe(false);
  });

  it("allows custom shouldRetry logic", () => {
    const p = makePolicy({
      shouldRetry: (e) =>
        e.type === "provider" && e.category === "server_error",
    });
    expect(
      p.shouldRetry({
        type: "provider",
        category: "server_error",
        message: "x",
        retryable: true,
      }),
    ).toBe(true);
    // Even though rate_limit is marked retryable, custom policy says no.
    expect(
      p.shouldRetry({
        type: "provider",
        category: "rate_limit",
        message: "x",
        retryable: true,
      }),
    ).toBe(false);
  });
});

describe("delayWithAbort", () => {
  it("resolves after the delay", async () => {
    const ac = new AbortController();
    const start = Date.now();
    await delayWithAbort(20, ac.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15); // tolerance
  });

  it("rejects immediately if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(delayWithAbort(100, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects when signal fires during delay", async () => {
    const ac = new AbortController();
    const pending = delayWithAbort(500, ac.signal);
    // Abort after a tiny delay
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

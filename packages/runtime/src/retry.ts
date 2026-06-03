import { type AgentError } from "@helm/core";

export interface RetryPolicy {
  /** Total attempts including the first call. Must be >= 1. */
  maxAttempts: number;
  /** Base backoff delay in ms before the first retry (attempt 2). */
  baseDelayMs: number;
  /** Hard cap on backoff delay. */
  maxDelayMs: number;
  /** Multiplier for exponential backoff. delay = baseDelay * multiplier^(retryIndex). */
  backoffMultiplier: number;
  /** When true, use full jitter: random([0, computedDelay]). */
  jitter: boolean;
  /** Return true if this agent error should trigger a retry. */
  shouldRetry(error: AgentError): boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitter: true,
  shouldRetry(error: AgentError): boolean {
    return error.retryable;
  },
};

export function computeDelay(
  policy: RetryPolicy,
  attemptNumber: number,
): number {
  // attemptNumber is the NEXT attempt (2, 3, ...).
  const retryIndex = attemptNumber - 2; // 0-indexed from first retry
  const raw =
    policy.baseDelayMs * Math.pow(policy.backoffMultiplier, retryIndex);
  const capped = Math.min(raw, policy.maxDelayMs);
  if (policy.jitter) {
    return Math.random() * capped;
  }
  return capped;
}

/**
 * Sleep for `ms` milliseconds, aborting if the signal fires.
 * Rejects so the caller can distinguish "delay completed" from "delay cancelled".
 */
export function delayWithAbort(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      const reason =
        typeof signal.reason === "string" && signal.reason.length > 0
          ? signal.reason
          : "The operation was aborted";
      const err = new Error(reason);
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const reason =
        typeof signal.reason === "string" && signal.reason.length > 0
          ? signal.reason
          : "The operation was aborted";
      const err = new Error(reason);
      err.name = "AbortError";
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

import { type Provider, type JsonlJournal, type TokenBudget, classifyAgentError } from "@helm/core";
import { type ToolRuntime } from "./tool-runtime.js";
import {
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  computeDelay,
  delayWithAbort,
} from "./retry.js";
import { ContextBuilder, toToolDefs } from "./context-builder.js";
import { CharTokenCounter } from "./token-counter.js";
import { type Compaction } from "./compaction.js";

export interface AgentLoopOptions {
  maxTurns: number;
  /** Optional external AbortSignal — caller can cancel a run mid-flight. */
  signal?: AbortSignal;
  /** Optional wall-clock cap in ms — fires an internal abort when exceeded. */
  maxDurationMs?: number;
  /**
   * Retry policy for provider call failures. If omitted, the provider is
   * called at most once per turn (no retries). Pass DEFAULT_RETRY_POLICY
   * for a reasonable starting point (3 attempts, exponential+jitter backoff).
   */
  retryPolicy?: RetryPolicy;
  /**
   * Token budget for this run. When set, AgentLoop checks before each
   * provider call that the estimated context tokens fit within the
   * remaining budget. Exhaustion stops the run with a harness error.
   */
  tokenBudget?: TokenBudget;
  /**
   * Context builder used to estimate token counts for budget checks.
   * Required when tokenBudget is set. Defaults to a CharTokenCounter
   * with 4 chars/token if omitted but tokenBudget is provided.
   */
  contextBuilder?: ContextBuilder;
  /**
   * Compaction module for compressing message history when the token
   * budget reaches its warning threshold. When omitted, no compaction
   * is attempted (backward-compatible).
   */
  compaction?: Compaction;
  /**
   * Parent runId for subagents. Top-level runs leave this undefined.
   * When set, the run:start event includes it for run tree reconstruction.
   */
  parentRunId?: string | null;
}

export interface AgentLoopResult {
  exitCode: number;
  cancelled?: { reason: "external" | "timeout" };
  /** True if any permission was denied during the run. */
  permissionDenied: boolean;
}

const EXIT_OK = 0;
const EXIT_CANCELLED = 130; // SIGINT convention
const EXIT_ERROR = 1;
const EXIT_PERMISSION_DENIED = 2;

export class AgentLoop {
  constructor(
    private provider: Provider,
    private toolRuntime: ToolRuntime,
    private journal: JsonlJournal,
    private options: AgentLoopOptions = { maxTurns: 10 },
  ) {}

  async run(runId: string, userMessage: string): Promise<AgentLoopResult> {
    const messages: Array<{
      role: string;
      content: string;
      toolCalls?: unknown;
      toolCallId?: string;
    }> = [{ role: "user", content: userMessage }];

    // Combine external signal + timeout into a single internal controller.
    const controller = new AbortController();
    let cancelReason: "external" | "timeout" | null = null;

    const externalSignal = this.options.signal;
    const onExternalAbort = () => {
      cancelReason = "external";
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        cancelReason = "external";
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (
      this.options.maxDurationMs !== undefined &&
      !controller.signal.aborted
    ) {
      timeoutHandle = setTimeout(() => {
        cancelReason = "timeout";
        controller.abort();
      }, this.options.maxDurationMs);
    }

    const cleanup = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    };

    const isAborted = () => controller.signal.aborted;

    const retryPolicy = this.options.retryPolicy;
    const maxAttempts = retryPolicy ? retryPolicy.maxAttempts : 1;

    await this.journal.append({
      type: "run:start",
      runId,
      parentRunId: this.options.parentRunId ?? null,
      timestamp: Date.now(),
    });

    // Pre-loop cancellation check (e.g., signal already aborted before run started).
    if (isAborted()) {
      await this.journal.append({
        type: "run:cancelled",
        runId,
        reason: cancelReason ?? "external",
        timestamp: Date.now(),
      });
      await this.journal.append({
        type: "run:end",
        runId,
        timestamp: Date.now(),
        exitCode: EXIT_CANCELLED,
      });
      cleanup();
      return {
        exitCode: EXIT_CANCELLED,
        cancelled: { reason: cancelReason ?? "external" },
        permissionDenied: false,
      };
    }

    let exitCode = EXIT_OK;
    let permissionDenied = false;
    let wasCompacted = false;
    let cancelled: { reason: "external" | "timeout" } | undefined;

    try {
      for (
        let turnIndex = 0;
        turnIndex < this.options.maxTurns;
        turnIndex++
      ) {
        if (isAborted()) break;

        await this.journal.append({
          type: "turn:start",
          runId,
          turnIndex,
          timestamp: Date.now(),
        });

        // ── Token budget check ────────────────────────────────────────
        if (this.options.tokenBudget) {
          const cb =
            this.options.contextBuilder ??
            new ContextBuilder(new CharTokenCounter());
          const toolDefs = toToolDefs(this.toolRuntime.list());

          // ── Compaction trigger ────────────────────────────────────
          // Compact when: budget is at warning level, compaction is
          // configured, and we haven't already compacted in this run.
          if (
            this.options.compaction &&
            this.options.tokenBudget.isWarning() &&
            !wasCompacted
          ) {
            const windowBefore = cb.build({
              messages: messages as Parameters<ContextBuilder["build"]>[0]["messages"],
              toolDefs,
            });

            const result = await this.options.compaction.compact(
              messages as Parameters<Compaction["compact"]>[0],
              this.toolRuntime.list(),
              controller.signal,
            );

            if (result.didCompact) {
              // Replace the message list with the compacted version
              messages.length = 0;
              messages.push(...(result.messages as typeof messages));

              wasCompacted = true;

              await this.journal.append({
                type: "compaction",
                runId,
                turnIndex,
                strategy: this.options.compaction!.strategy,
                messageCountBefore: result.messageCountBefore,
                messageCountAfter: result.messageCountAfter,
                tokensEstimatedBefore: result.tokensEstimatedBefore,
                tokensEstimatedAfter: result.tokensEstimatedAfter,
                summaryText: result.summaryText,
                timestamp: Date.now(),
              });

              // Reset budget to reflect the compacted state
              this.options.tokenBudget.reset();
            }
          }

          const window = cb.build({
            messages: messages as Parameters<ContextBuilder["build"]>[0]["messages"],
            toolDefs,
          });
          if (window.estimatedTokens > this.options.tokenBudget.remainingTokens) {
            await this.journal.append({
              type: "error",
              runId,
              message: `Token budget exhausted: ${window.estimatedTokens} tokens needed, ${this.options.tokenBudget.remainingTokens} remaining of ${this.options.tokenBudget.maxTokens}`,
              errorType: "harness",
              errorCategory: "budget_exhausted",
              timestamp: Date.now(),
            });
            exitCode = EXIT_ERROR;
            break;
          }
          this.options.tokenBudget.consume(window.estimatedTokens);
        }

        // ── Provider call with retry ────────────────────────────────────
        // Notify provider about available tools before the call.
        // ScriptedProvider doesn't implement setTools — the optional
        // call is silently skipped for providers that don't need it.
        this.provider.setTools?.(toToolDefs(this.toolRuntime.list()));

        let response: Awaited<ReturnType<Provider["send"]>> | null = null;
        let providerSucceeded = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (isAborted()) break;

          try {
            response = await this.provider.send(
              messages as Parameters<Provider["send"]>[0],
              controller.signal,
            );
            providerSucceeded = true;
            break;
          } catch (err) {
            // Distinguish abort from genuine error.
            if (isAborted()) break;

            const agentError = classifyAgentError(err);

            // Always emit an error event, now with classification.
            await this.journal.append({
              type: "error",
              runId,
              message: agentError.message,
              errorType: agentError.type,
              errorCategory: agentError.category,
              timestamp: Date.now(),
            });

            // Check retry eligibility.
            if (
              retryPolicy &&
              retryPolicy.shouldRetry(agentError) &&
              attempt < maxAttempts
            ) {
              const delayMs = computeDelay(retryPolicy, attempt + 1);

              await this.journal.append({
                type: "retry",
                runId,
                turnIndex,
                phase: "attempt",
                attemptNumber: attempt + 1,
                maxAttempts,
                errorMessage: agentError.message,
                delayMs,
                timestamp: Date.now(),
              });

              // Abortable delay.
              try {
                await delayWithAbort(delayMs, controller.signal);
              } catch {
                // Aborted during backoff — break both loops.
                break;
              }
              continue;
            }

            // Not retryable or max attempts exhausted.
            // Only emit exhausted when retries were actually configured
            // and we consumed all of them.
            if (retryPolicy && attempt >= maxAttempts) {
              await this.journal.append({
                type: "retry",
                runId,
                turnIndex,
                phase: "exhausted",
                attemptNumber: attempt,
                maxAttempts,
                errorMessage: agentError.message,
                delayMs: 0,
                timestamp: Date.now(),
              });
              exitCode = EXIT_ERROR;
            }

            break;
          }
        }

        // If the provider call failed (after retries) or we were aborted,
        // exit the turn loop.
        if (!providerSucceeded || !response || isAborted()) break;

        const res = response; // definite assignment for TS narrowing
        messages.push(res);

        if (
          res.role === "assistant" &&
          res.toolCalls &&
          res.toolCalls.length > 0
        ) {
          let breakOuter = false;
          for (const tc of res.toolCalls) {
            if (isAborted()) {
              breakOuter = true;
              break;
            }
            await this.journal.append({
              type: "tool:call",
              runId,
              turnIndex,
              toolName: tc.name,
              args: tc.args,
              timestamp: Date.now(),
            });

            // Permission check (if PermissionRuntime configured)
            const permDecision = this.toolRuntime.checkPermission(
              tc.name,
              tc.args,
            );

            let output: string;

            if (permDecision) {
              if (permDecision.allowed) {
                await this.journal.append({
                  type: "permission:allowed",
                  runId,
                  turnIndex,
                  toolName: tc.name,
                  timestamp: Date.now(),
                });
              } else {
                permissionDenied = true;
                await this.journal.append({
                  type: "permission:denied",
                  runId,
                  turnIndex,
                  toolName: tc.name,
                  reason: permDecision.reason ?? "unknown",
                  timestamp: Date.now(),
                });
                output = `Error: permission denied — ${permDecision.reason}`;

                await this.journal.append({
                  type: "tool:result",
                  runId,
                  turnIndex,
                  toolName: tc.name,
                  output,
                  timestamp: Date.now(),
                });

                messages.push({
                  role: "tool",
                  content: output,
                  toolCallId: tc.id,
                });
                continue;
              }
            }

            try {
              output = await this.toolRuntime.execute(
                tc.name,
                tc.args,
                controller.signal,
              );
            } catch (err) {
              if (isAborted()) {
                breakOuter = true;
                break;
              }
              output =
                err instanceof Error
                  ? `Error: ${err.message}`
                  : `Error: ${String(err)}`;
            }

            await this.journal.append({
              type: "tool:result",
              runId,
              turnIndex,
              toolName: tc.name,
              output,
              timestamp: Date.now(),
            });

            messages.push({
              role: "tool",
              content: output,
              toolCallId: tc.id,
            });
          }
          if (breakOuter) break;
        } else {
          // No tool calls — assistant gave final answer, end the loop
          break;
        }
      }

      if (isAborted()) {
        const reason = cancelReason ?? "external";
        await this.journal.append({
          type: "run:cancelled",
          runId,
          reason,
          timestamp: Date.now(),
        });
        exitCode = EXIT_CANCELLED;
        cancelled = { reason };
      }
    } finally {
      cleanup();
    }

    await this.journal.append({
      type: "run:end",
      runId,
      timestamp: Date.now(),
      exitCode,
    });

    return cancelled
      ? { exitCode, cancelled, permissionDenied }
      : { exitCode, permissionDenied };
  }
}

import { type Provider, type JsonlJournal } from "@helm/core";
import { type ToolRuntime } from "./tool-runtime.js";

export interface AgentLoopOptions {
  maxTurns: number;
  /** Optional external AbortSignal — caller can cancel a run mid-flight. */
  signal?: AbortSignal;
  /** Optional wall-clock cap in ms — fires an internal abort when exceeded. */
  maxDurationMs?: number;
}

export interface AgentLoopResult {
  exitCode: number;
  cancelled?: { reason: "external" | "timeout" };
}

const EXIT_OK = 0;
const EXIT_CANCELLED = 130; // SIGINT convention

export class AgentLoop {
  constructor(
    private provider: Provider,
    private toolRuntime: ToolRuntime,
    private journal: JsonlJournal,
    private options: AgentLoopOptions = { maxTurns: 10 }
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
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (this.options.maxDurationMs !== undefined && !controller.signal.aborted) {
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

    await this.journal.append({
      type: "run:start",
      runId,
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
      };
    }

    let exitCode = EXIT_OK;
    let cancelled: { reason: "external" | "timeout" } | undefined;

    try {
      for (let turnIndex = 0; turnIndex < this.options.maxTurns; turnIndex++) {
        if (isAborted()) break;

        await this.journal.append({
          type: "turn:start",
          runId,
          turnIndex,
          timestamp: Date.now(),
        });

        let response: Awaited<ReturnType<Provider["send"]>>;
        try {
          response = await this.provider.send(
            messages as Parameters<Provider["send"]>[0],
            controller.signal
          );
        } catch (err) {
          // Distinguish abort from genuine error — if our merged signal aborted,
          // it's cancellation, regardless of how the provider expressed it.
          if (isAborted()) break;
          const message = err instanceof Error ? err.message : String(err);
          await this.journal.append({
            type: "error",
            runId,
            message,
            timestamp: Date.now(),
          });
          break;
        }

        messages.push(response);

        if (
          response.role === "assistant" &&
          response.toolCalls &&
          response.toolCalls.length > 0
        ) {
          let breakOuter = false;
          for (const tc of response.toolCalls) {
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

            let output: string;
            try {
              output = await this.toolRuntime.execute(
                tc.name,
                tc.args,
                controller.signal
              );
            } catch (err) {
              if (isAborted()) {
                breakOuter = true;
                break;
              }
              output = `Error: ${err instanceof Error ? err.message : String(err)}`;
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

    return cancelled ? { exitCode, cancelled } : { exitCode };
  }
}

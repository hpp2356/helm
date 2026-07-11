export type RunEvent =
  | { type: "run:start"; runId: string; timestamp: number; parentRunId?: string | null }
  | { type: "run:end"; runId: string; timestamp: number; exitCode: number }
  | { type: "turn:start"; runId: string; turnIndex: number; timestamp: number }
  | { type: "turn:end"; runId: string; turnIndex: number; timestamp: number }
  | {
      type: "assistant:text";
      runId: string;
      turnIndex: number;
      /** Intermediate text the model produced before issuing tool calls. */
      content: string;
      timestamp: number;
    }
  | {
      type: "tool:call";
      runId: string;
      turnIndex: number;
      toolName: string;
      args: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "tool:result";
      runId: string;
      turnIndex: number;
      toolName: string;
      output: string;
      timestamp: number;
    }
  | {
      type: "error";
      runId: string;
      message: string;
      stack?: string;
      /** Error classification — omitted for legacy unclassified errors. */
      errorType?: "provider" | "tool" | "harness";
      errorCategory?: string;
      timestamp: number;
    }
  | {
      type: "run:cancelled";
      runId: string;
      reason: "external" | "timeout";
      timestamp: number;
    }
  | {
      type: "retry";
      runId: string;
      turnIndex: number;
      phase: "attempt" | "exhausted";
      attemptNumber: number;
      maxAttempts: number;
      errorMessage: string;
      delayMs: number;
      timestamp: number;
    }
  | {
      type: "permission:allowed";
      runId: string;
      turnIndex: number;
      toolName: string;
      timestamp: number;
    }
  | {
      type: "permission:denied";
      runId: string;
      turnIndex: number;
      toolName: string;
      reason: string;
      timestamp: number;
    }
  | {
      type: "compaction";
      runId: string;
      turnIndex: number;
      /** The strategy used to compact. */
      strategy: "summarize" | "truncate";
      /** Number of messages before compaction. */
      messageCountBefore: number;
      /** Number of messages after compaction. */
      messageCountAfter: number;
      /** Estimated tokens before compaction. */
      tokensEstimatedBefore: number;
      /** Estimated tokens after compaction. */
      tokensEstimatedAfter: number;
      /** Human-readable summary (optional, only for summarize strategy). */
      summaryText?: string;
      timestamp: number;
    }
  | {
      type: "subagent:spawn";
      /** The parent agent's runId. */
      runId: string;
      /** The child subagent's runId. */
      childRunId: string;
      /** Task description passed to the subagent. */
      task: string;
      timestamp: number;
    }
  | {
      type: "subagent:complete";
      /** The child subagent's runId. */
      runId: string;
      parentRunId: string;
      /** Exit code from the child AgentLoop. */
      exitCode: number;
      /** Summary of what the subagent did (tool calls, results, final answer). */
      summary: string;
      timestamp: number;
    }
  | {
      type: "mcp:connect";
      runId: string;
      serverName: string;
      toolCount: number;
      transport: "stdio" | "sse" | "streamableHttp";
      timestamp: number;
    }
  | {
      type: "mcp:disconnect";
      runId: string;
      serverName: string;
      timestamp: number;
    };

export function eventToString(event: RunEvent): string {
  return JSON.stringify(event);
}

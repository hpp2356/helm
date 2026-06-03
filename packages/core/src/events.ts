export type RunEvent =
  | { type: "run:start"; runId: string; timestamp: number }
  | { type: "run:end"; runId: string; timestamp: number; exitCode: number }
  | { type: "turn:start"; runId: string; turnIndex: number; timestamp: number }
  | { type: "turn:end"; runId: string; turnIndex: number; timestamp: number }
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
    };

export function eventToString(event: RunEvent): string {
  return JSON.stringify(event);
}

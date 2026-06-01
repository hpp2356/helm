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
      timestamp: number;
    };

export function eventToString(event: RunEvent): string {
  return JSON.stringify(event);
}

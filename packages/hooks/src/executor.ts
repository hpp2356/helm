// packages/hooks/src/executor.ts

import { spawn } from "node:child_process";
import type { HookHandlerDef, HookInput, HookOutput, HookResult } from "./types.js";

const DEFAULT_TIMEOUT = 5000;

/**
 * Execute a single hook handler (command type).
 *
 * - Sends HookInput as JSON to stdin
 * - Reads HookOutput as JSON from stdout
 * - Respects timeout
 * - Never throws — errors are captured in HookResult
 */
export async function executeHandler(
  handler: HookHandlerDef,
  input: HookInput,
  signal?: AbortSignal,
): Promise<HookResult> {
  const startTime = Date.now();
  const timeout = handler.timeout ?? DEFAULT_TIMEOUT;

  try {
    const result = await spawnCommand(handler.command, input, timeout, signal);
    const durationMs = Date.now() - startTime;

    if (result.timedOut) {
      return {
        decision: "allow",
        timedOut: true,
        error: `Hook timed out after ${timeout}ms`,
        durationMs,
      };
    }

    if (result.exitCode !== 0) {
      return {
        decision: "allow",
        error: `Hook exited with code ${result.exitCode}: ${result.stderr}`,
        durationMs,
      };
    }

    // Parse JSON output
    const output = parseHookOutput(result.stdout);
    return {
      decision: output.decision ?? "allow",
      reason: output.reason,
      modifiedInput: output.modified_input,
      systemMessage: output.system_message,
      durationMs,
    };
  } catch (err) {
    return {
      decision: "allow",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnCommand(
  command: string,
  input: HookInput,
  timeout: number,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Write input JSON to stdin (handle EPIPE if process exits early)
    const inputJson = JSON.stringify(input);
    proc.stdin.on("error", () => {
      // Ignore stdin errors (EPIPE when process exits before we write)
    });
    try {
      proc.stdin.write(inputJson);
      proc.stdin.end();
    } catch {
      // Process may have already exited
    }

    // Timeout — use SIGTERM then SIGKILL fallback
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
      // Force kill after 1s if SIGTERM didn't work
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already dead
        }
      }, 1000);
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
        // Process was killed (likely by signal)
        resolve({
          exitCode: 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
        });
        return;
      }
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}

/**
 * Parse hook output from stdout.
 * Tolerant: non-JSON stdout is treated as allow with system_message.
 */
function parseHookOutput(stdout: string): HookOutput {
  if (!stdout) return {};

  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        decision: typeof obj.decision === "string" ? obj.decision as HookOutput["decision"] : undefined,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
        modified_input: obj.modified_input && typeof obj.modified_input === "object"
          ? obj.modified_input as Record<string, unknown>
          : undefined,
        system_message: typeof obj.system_message === "string" ? obj.system_message : undefined,
      };
    }
    return {};
  } catch {
    // Non-JSON output — treat as system message
    return { system_message: stdout };
  }
}

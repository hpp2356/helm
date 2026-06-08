import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Tool } from "@helm/core";
import { RiskLevel } from "@helm/core";
import { WorkspaceGuard } from "./workspace-guard.js";
import { BashSafety } from "./bash-safety.js";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 256 * 1024; // 256KB per stream

// ── Options ─────────────────────────────────────────────────────────────────

export interface BashToolOptions {
  guard: WorkspaceGuard;
  safety: BashSafety;
  workspaceRoot: string;
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function createBashTool(opts: BashToolOptions): Tool {
  return {
    name: "bash",
    description:
      "Execute a bash shell command within the workspace. Safety checks block dangerous commands.",
    riskLevel: RiskLevel.CRITICAL,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        cwd: {
          type: "string",
          description: "Working directory relative to workspace root (defaults to workspace root)",
        },
        env: {
          type: "object",
          description: "Additional environment variables (merged with process.env)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds",
        },
      },
      required: ["command"],
    },
    async execute(
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string> {
      const command = String(args.command ?? "");
      if (!command) return "Error: command is required";

      // 1. Validate cwd through WorkspaceGuard
      const rawCwd = args.cwd !== undefined ? String(args.cwd) : ".";
      let resolvedCwd: string;
      try {
        resolvedCwd = opts.guard.validate(rawCwd);
      } catch (err) {
        return `Error: cwd — ${err instanceof Error ? err.message : String(err)}`;
      }

      // Verify cwd exists and is a directory
      try {
        const stat = fs.statSync(resolvedCwd);
        if (!stat.isDirectory()) {
          return `Error: cwd "${rawCwd}" is not a directory`;
        }
      } catch {
        return `Error: cwd "${rawCwd}" not found`;
      }

      // 2. BashSafety check
      const safetyResult = opts.safety.check(command);
      if (!safetyResult.safe) {
        const reason = safetyResult.reason ?? "command blocked by safety policy";
        return `Error: command blocked by safety — ${reason}`;
      }

      // 3. Check for pre-aborted signal before spawning
      if (signal?.aborted) {
        return JSON.stringify({ exitCode: -1, stdout: "", stderr: "", killed: true });
      }

      // 4. Execute
      const timeout = args.timeout !== undefined ? Number(args.timeout) : undefined;

      return new Promise<string>((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd: resolvedCwd,
          env: { ...process.env, ...(args.env as Record<string, string> | undefined) },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // own process group so we can kill the entire tree
        });

        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let killed = false;

        // Kill the entire process group (shell + its children).
        // On Linux, dash as /bin/sh does not forward signals to foreground
        // children, so child.kill() only kills the shell.  detached: true
        // gives the child its own process group, and process.kill(-pgid)
        // kills everything in that group.
        const killPg = (signal: NodeJS.Signals) => {
          try {
            if (child.pid !== undefined) {
              process.kill(-child.pid, signal);
            } else {
              child.kill(signal);
            }
          } catch {
            // Fallback if process group doesn't exist (e.g. already exited)
            child.kill(signal);
          }
        };

        // Timeout guard
        const timeoutHandle =
          timeout && timeout > 0
            ? setTimeout(() => {
                killed = true;
                killPg("SIGTERM");
                // Force kill after 2s if still alive
                const forceHandle = setTimeout(() => {
                  if (!child.killed) killPg("SIGKILL");
                }, 2000);
                // Don't let the force handle keep the process alive
                if (forceHandle.unref) forceHandle.unref();
              }, timeout)
            : undefined;

        // External signal handling (signal.aborted already checked above)
        const onAbort = () => {
          killed = true;
          killPg("SIGTERM");
        };
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutTruncated) return;
          const str = chunk.toString("utf-8");
          if (stdout.length + str.length > MAX_OUTPUT_BYTES) {
            stdout += str.slice(0, MAX_OUTPUT_BYTES - stdout.length);
            stdoutTruncated = true;
          } else {
            stdout += str;
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrTruncated) return;
          const str = chunk.toString("utf-8");
          if (stderr.length + str.length > MAX_OUTPUT_BYTES) {
            stderr += str.slice(0, MAX_OUTPUT_BYTES - stderr.length);
            stderrTruncated = true;
          } else {
            stderr += str;
          }
        });

        child.on("close", (exitCode) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          const truncationNote = "\n[Output truncated — exceeded size limit]";
          resolve(
            JSON.stringify({
              exitCode: exitCode ?? -1,
              stdout: stdoutTruncated ? stdout + truncationNote : stdout,
              stderr: stderrTruncated ? stderr + truncationNote : stderr,
              killed,
            }),
          );
        });

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(`Error: ${err.message}`);
        });
      });
    },
  };
}

// ── Registration helper ─────────────────────────────────────────────────────

export function registerBashTool(
  toolRuntime: { register(tool: Tool): void },
  workspaceRoot: string,
): { guard: WorkspaceGuard; safety: BashSafety } {
  const guard = new WorkspaceGuard(workspaceRoot);
  const safety = new BashSafety(guard);
  toolRuntime.register(
    createBashTool({ guard, safety, workspaceRoot }),
  );
  return { guard, safety };
}

// ── Risk level metadata ─────────────────────────────────────────────────────

export const BASH_TOOL_RISK_LEVEL: Record<string, RiskLevel> = {
  bash: RiskLevel.CRITICAL,
};

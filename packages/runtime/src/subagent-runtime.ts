import { type Provider, type Tool, JsonlJournal } from "@helm/core";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import { ToolRuntime } from "./tool-runtime.js";
import type { PermissionRuntime } from "./permission-runtime.js";
import type { PermissionPolicy } from "@helm/core";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubagentSpawnArgs {
  /** Task description for the subagent. */
  task: string;
  /**
   * Tool names to restrict the subagent to.
   * When omitted, the subagent inherits all parent tools.
   */
  tools?: string[];
}

export interface SubagentResult {
  exitCode: number;
  /** Structured summary of the subagent's work. */
  summary: string;
  /** Journal events from the child agent. */
  events: Record<string, unknown>[];
}

export interface SubagentRuntimeOptions {
  /** Shared provider for all subagents. */
  provider: Provider;
  /** Journal file path for all agents (same file for tree consolidation). */
  journalPath: string;
  /** Parent's tool runtime for tool inheritance. */
  toolRuntime: ToolRuntime;
  /** Parent's permission runtime for permission inheritance. */
  permissionRuntime?: PermissionRuntime;
  /** Parent's permission policy for inheritance. */
  permissionPolicy?: PermissionPolicy;
  /** Maximum subagent nesting depth (default: 3). */
  maxDepth?: number;
  /** External AbortSignal from parent for cancellation propagation. */
  signal?: AbortSignal;
  /** Optional AgentLoop options overrides (maxTurns, etc.). */
  agentLoopOptions?: Partial<AgentLoopOptions>;
}

// ── SubagentRuntime ─────────────────────────────────────────────────────────

export class SubagentRuntime {
  readonly maxDepth: number;

  constructor(private opts: SubagentRuntimeOptions) {
    this.maxDepth = opts.maxDepth ?? 3;
  }

  /**
   * Spawn a subagent to execute a task.
   *
   * @param task - The task description for the subagent.
   * @param parentRunId - The parent agent's runId.
   * @param currentDepth - Current nesting depth (0 for top-level).
   * @param allowedTools - Tool names to allow (undefined = all parent tools).
   */
  async spawn(
    task: string,
    parentRunId: string,
    currentDepth: number,
    allowedTools?: string[],
  ): Promise<SubagentResult> {
    // ── Depth check ─────────────────────────────────────────────────
    if (currentDepth >= this.maxDepth) {
      return {
        exitCode: 1,
        summary: `Error: subagent spawn refused — max depth ${this.maxDepth} reached (current depth: ${currentDepth})`,
        events: [],
      };
    }

    const childRunId = `${parentRunId}-s${currentDepth + 1}`;
    const childJournal = new JsonlJournal(this.opts.journalPath);
    await childJournal.open();

    // ── Build child tools ───────────────────────────────────────────
    const childToolRuntime = new ToolRuntime(
      this.opts.permissionRuntime,
      this.opts.permissionPolicy,
    );

    if (allowedTools && allowedTools.length > 0) {
      for (const name of allowedTools) {
        const tool = this.opts.toolRuntime.get(name);
        if (tool) {
          childToolRuntime.register(tool);
        }
      }
    } else {
      for (const tool of this.opts.toolRuntime.list()) {
        childToolRuntime.register(tool);
      }
    }

    // ── Spawn event ─────────────────────────────────────────────────
    await childJournal.append({
      type: "subagent:spawn",
      runId: parentRunId,
      childRunId,
      task,
      timestamp: Date.now(),
    });

    // ── Child AgentLoop ─────────────────────────────────────────────
    const childLoop = new AgentLoop(
      this.opts.provider,
      childToolRuntime,
      childJournal,
      {
        maxTurns: this.opts.agentLoopOptions?.maxTurns ?? 5,
        signal: this.opts.signal,
        maxDurationMs: this.opts.agentLoopOptions?.maxDurationMs,
        retryPolicy: this.opts.agentLoopOptions?.retryPolicy,
        tokenBudget: this.opts.agentLoopOptions?.tokenBudget,
        contextBuilder: this.opts.agentLoopOptions?.contextBuilder,
        compaction: this.opts.agentLoopOptions?.compaction,
        parentRunId,
      },
    );

    // ── Run child ───────────────────────────────────────────────────
    let result;
    try {
      result = await childLoop.run(childRunId, task);
    } catch (err) {
      await childJournal.append({
        type: "error",
        runId: childRunId,
        message: err instanceof Error ? err.message : String(err),
        errorType: "harness",
        errorCategory: "subagent_crash",
        timestamp: Date.now(),
      });
      await childJournal.append({
        type: "run:end",
        runId: childRunId,
        timestamp: Date.now(),
        exitCode: 1,
      });
      await childJournal.close();

      return {
        exitCode: 1,
        summary: `Subagent crashed: ${err instanceof Error ? err.message : String(err)}`,
        events: [],
      };
    }

    // ── Build summary ───────────────────────────────────────────────
    const statusLabel = result.cancelled
      ? `cancelled (${result.cancelled.reason})`
      : `exitCode=${result.exitCode}`;

    const summary = [
      `Subagent ${childRunId} completed: ${statusLabel}`,
      result.permissionDenied ? "  - Permission was denied" : "",
      `  - Tools available: ${childToolRuntime.getToolNames().join(", ") || "none"}`,
    ]
      .filter(Boolean)
      .join("\n");

    // ── Complete event (append after child journal closes) ─────────
    await childJournal.append({
      type: "subagent:complete",
      runId: childRunId,
      parentRunId,
      exitCode: result.exitCode,
      summary,
      timestamp: Date.now(),
    });
    await childJournal.close();

    return {
      exitCode: result.exitCode,
      summary,
      events: [],
    };
  }
}

// ── Tool factory ────────────────────────────────────────────────────────────

/**
 * Create a `spawn_subagent` tool that delegates to a SubagentRuntime.
 *
 * The tool's execute function captures the SubagentRuntime and the
 * parent's runId + depth so it can call spawn().
 */
export function createSubagentTool(
  subagentRuntime: SubagentRuntime,
  parentRunId: string,
  currentDepth: number,
): Tool {
  return {
    name: "spawn_subagent",
    description:
      "Spawn a subagent to handle an independent subtask. The subagent has its own turn loop and tools. Use this to delegate work.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the subagent.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of tool names to restrict the subagent to. If omitted, inherits all parent tools.",
        },
      },
      required: ["task"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const task = String(args.task ?? "");
      if (!task) return "Error: task is required";

      const tools = Array.isArray(args.tools)
        ? (args.tools as string[])
        : undefined;

      const result = await subagentRuntime.spawn(
        task,
        parentRunId,
        currentDepth,
        tools,
      );

      return JSON.stringify(result);
    },
  };
}

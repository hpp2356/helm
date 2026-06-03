import {
  type RunEvent,
  type Message,
  type Tool,
  type Provider,
  JsonlJournal,
} from "@helm/core";
import {
  AgentLoop,
  ToolRuntime,
  ScriptedProvider,
  type ScriptedResponse,
} from "@helm/runtime";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────

export type EvalAssertion =
  | { type: "event:exists"; eventType: string }
  | { type: "event:order"; eventTypes: string[] }
  | { type: "tool:called"; toolName: string; args?: Record<string, unknown> }
  | { type: "final:answer"; contains?: string; matches?: string }
  | { type: "error:category"; errorCategory: string }
  | { type: "no:error" };

export interface EvalCase {
  name: string;
  description?: string;
  script: ScriptedResponse[];
  tools?: Tool[];
  assertions: EvalAssertion[];
  userMessage?: string;
  maxTurns?: number;
}

export interface EvalResult {
  assertion: EvalAssertion;
  pass: boolean;
  actual: unknown;
  expected: unknown;
  message?: string;
}

export interface EvalCaseResult {
  caseName: string;
  pass: boolean;
  results: EvalResult[];
}

export interface EvalSuiteResult {
  cases: EvalCaseResult[];
  totalCases: number;
  passedCases: number;
  failedCases: number;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  summary: string;
}

// ── Provider wrapper ──────────────────────────────────────────────────────

class CapturingProvider implements Provider {
  public messages: Message[] = [];

  constructor(private inner: Provider) {}

  async send(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<Message> {
    const response = await this.inner.send(messages, signal);
    this.messages.push(response);
    return response;
  }
}

// ── Journal reader ────────────────────────────────────────────────────────

function readJournal(filePath: string): RunEvent[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isSubset(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

function isSubsequence(actual: string[], expected: string[]): boolean {
  let ei = 0;
  for (const a of actual) {
    if (ei < expected.length && a === expected[ei]) {
      ei++;
    }
  }
  return ei === expected.length;
}

// ── Assertion evaluation ──────────────────────────────────────────────────

export function evaluateAssertion(
  assertion: EvalAssertion,
  events: RunEvent[],
  capturedMessages: Message[],
): EvalResult {
  const eventTypes = events.map((e) => e.type);

  switch (assertion.type) {
    case "event:exists": {
      const found = events.some((e) => e.type === assertion.eventType);
      return {
        assertion,
        pass: found,
        actual: eventTypes,
        expected: assertion.eventType,
        message: found
          ? undefined
          : `expected event "${assertion.eventType}" not found`,
      };
    }

    case "event:order": {
      const pass = isSubsequence(eventTypes, assertion.eventTypes);
      return {
        assertion,
        pass,
        actual: eventTypes,
        expected: assertion.eventTypes,
        message: pass ? undefined : `expected subsequence not found`,
      };
    }

    case "tool:called": {
      const matchingCalls = events.filter(
        (e) => e.type === "tool:call" && e.toolName === assertion.toolName,
      );
      let pass = matchingCalls.length > 0;
      if (pass && assertion.args) {
        pass = matchingCalls.some((tc) => {
          if (tc.type !== "tool:call") return false;
          return isSubset(assertion.args!, tc.args);
        });
      }
      const toolCalls = events
        .filter((e) => e.type === "tool:call")
        .map((e) =>
          e.type === "tool:call"
            ? { toolName: e.toolName, args: e.args }
            : null,
        );
      return {
        assertion,
        pass,
        actual: toolCalls,
        expected: {
          toolName: assertion.toolName,
          ...(assertion.args ? { args: assertion.args } : {}),
        },
        message: pass
          ? undefined
          : `expected tool "${assertion.toolName}" to be called${assertion.args ? " with matching args" : ""}`,
      };
    }

    case "final:answer": {
      const lastAssistant = [...capturedMessages]
        .reverse()
        .find((m) => m.role === "assistant");
      const content = lastAssistant?.content ?? null;
      let pass = content !== null;
      if (pass && assertion.contains) {
        pass = content!.includes(assertion.contains);
      }
      if (pass && assertion.matches) {
        pass = content === assertion.matches;
      }
      return {
        assertion,
        pass,
        actual: content,
        expected: {
          ...(assertion.contains ? { contains: assertion.contains } : {}),
          ...(assertion.matches ? { matches: assertion.matches } : {}),
        },
        message: pass
          ? undefined
          : content === null
            ? "no assistant message captured"
            : assertion.contains
              ? `expected final answer to contain "${assertion.contains}", got "${content}"`
              : `expected final answer to match "${assertion.matches}", got "${content}"`,
      };
    }

    case "error:category": {
      const matchingErrors = events.filter(
        (e) =>
          e.type === "error" &&
          (e.errorCategory === assertion.errorCategory ||
            e.errorType === assertion.errorCategory),
      );
      const pass = matchingErrors.length > 0;
      const errors = events
        .filter((e) => e.type === "error")
        .map((e) =>
          e.type === "error"
            ? {
                errorType: e.errorType,
                errorCategory: e.errorCategory,
                message: e.message,
              }
            : null,
        );
      return {
        assertion,
        pass,
        actual: errors,
        expected: assertion.errorCategory,
        message: pass
          ? undefined
          : `expected error with category "${assertion.errorCategory}" not found`,
      };
    }

    case "no:error": {
      const errorEvents = events.filter((e) => e.type === "error");
      const pass = errorEvents.length === 0;
      return {
        assertion,
        pass,
        actual: errorEvents,
        expected: "no errors",
        message: pass
          ? undefined
          : `expected no errors but found ${errorEvents.length}`,
      };
    }

    default: {
      const _exhaustive: never = assertion;
      return {
        assertion: _exhaustive,
        pass: false,
        actual: null,
        expected: null,
        message: `unknown assertion type`,
      };
    }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────

export class EvalRunner {
  async runCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-eval-"));
    const journalPath = path.join(tmpDir, "journal.jsonl");

    try {
      const toolRuntime = new ToolRuntime();
      if (evalCase.tools) {
        for (const tool of evalCase.tools) {
          toolRuntime.register(tool);
        }
      }

      const scriptedProvider = new ScriptedProvider(evalCase.script);
      const capturingProvider = new CapturingProvider(scriptedProvider);

      const journal = new JsonlJournal(journalPath);

      const runId = `eval-${evalCase.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const userMessage = evalCase.userMessage ?? "Run this eval case";

      const agentLoop = new AgentLoop(
        capturingProvider,
        toolRuntime,
        journal,
        { maxTurns: evalCase.maxTurns ?? 10 },
      );

      try {
        await journal.open();
        await agentLoop.run(runId, userMessage);
      } finally {
        try {
          await journal.close();
        } catch {
          // Best-effort close
        }
      }

      const events = readJournal(journalPath);

      const results = evalCase.assertions.map((assertion) =>
        evaluateAssertion(assertion, events, capturingProvider.messages),
      );

      const pass = results.every((r) => r.pass);

      return { caseName: evalCase.name, pass, results };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  async runSuite(cases: EvalCase[]): Promise<EvalSuiteResult> {
    const caseResults: EvalCaseResult[] = [];
    for (const evalCase of cases) {
      caseResults.push(await this.runCase(evalCase));
    }

    const passedCases = caseResults.filter((c) => c.pass).length;
    const failedCases = caseResults.filter((c) => !c.pass).length;
    const totalAssertions = caseResults.reduce(
      (sum, c) => sum + c.results.length,
      0,
    );
    const passedAssertions = caseResults.reduce(
      (sum, c) => sum + c.results.filter((r) => r.pass).length,
      0,
    );
    const failedAssertions = totalAssertions - passedAssertions;

    const lines: string[] = [];
    lines.push(`Cases: ${passedCases}/${caseResults.length} passed`);
    for (const cr of caseResults) {
      const status = cr.pass ? "PASS" : "FAIL";
      lines.push(`  ${status}  ${cr.caseName}`);
      for (const r of cr.results) {
        if (!r.pass) {
          lines.push(`    X ${r.message ?? "assertion failed"}`);
        }
      }
    }
    lines.push(`Assertions: ${passedAssertions}/${totalAssertions} passed`);

    return {
      cases: caseResults,
      totalCases: caseResults.length,
      passedCases,
      failedCases,
      totalAssertions,
      passedAssertions,
      failedAssertions,
      summary: lines.join("\n"),
    };
  }
}

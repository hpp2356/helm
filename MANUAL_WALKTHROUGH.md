# Helm Manual Walkthrough (PR00–PR05)

## How to read this document

This is a **trace-reading exercise**, not a test plan. Vitest already covers
correctness; this guide covers _understanding_. Each PR adds new event types
or new harness machinery, and the JSONL journal is the single artifact where
that machinery shows up at runtime — think SLF4J structured logs, but framed
as event sourcing for an agent run. After every command you'll open a `.jsonl`
file and read the events it produced; the focus is "what's new in the trace
this PR".

PR00–PR03 don't ship an end-user CLI surface — those PRs landed only in
`packages/core` and `packages/runtime`, so we exercise them through their
unit tests. The user-runnable CLI (`packages/cli/bin/run.js`) lands in PR04
and is what we use from PR04 onward.

## Setup (run once)

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install
pnpm build
```

Journals from CLI runs land in `/tmp/helm-<runId>.jsonl`. The CLI prints the
exact path at the bottom of its output.

```bash
ls /tmp/helm-*.jsonl 2>/dev/null   # see all journals you've produced
```

## PR00 — Bootstrap monorepo

### What this PR added to the harness

The TypeScript pnpm workspace itself: `packages/core`, `packages/runtime`,
`packages/eval`, `packages/replay`, plus shared `tsconfig.base.json` and the
root scripts (`typecheck`, `test`, `build`).

### Walkthrough

No journal yet. Verify the workspace builds:

```bash
pnpm install
pnpm build
pnpm typecheck
```

You should see five packages compile cleanly (`@helm/core`, `@helm/runtime`,
`@helm/eval`, `@helm/replay`, `@helm/cli` — the last only after PR04). Nothing
else to look at; this PR is pure infrastructure, like running `mvn -N install`
on a brand-new multi-module Maven parent before any of the modules have code.

## PR01 — RunEvent + JsonlJournal

### What this PR added to the harness

The first persistent artifact: a discriminated-union `RunEvent` type and a
`JsonlJournal` writer that appends one JSON object per line. Nothing reads
this journal yet — the loop and tools don't exist — so the only way to see
it in action is the journal's own tests.

### Walkthrough

```bash
pnpm --filter @helm/core exec vitest run src/journal.test.ts --reporter=verbose
```

You'll see six green tests. The interesting ones are:

- `should append multiple events as separate JSONL lines` — proves the
  contract: each `append(event)` writes exactly one line, no embedded
  newlines.
- `should reopen and append to an existing file` — `open` uses `"a"` mode,
  so journals are append-only across runs.

To **see** what those events look like serialized, read
`packages/core/src/events.test.ts` — every variant of `RunEvent` is
constructed there. The PR01 set is: `run:start`, `run:end`, `turn:start`,
`turn:end`, `tool:call`, `tool:result`, `error`. (`run:cancelled` is added
in PR05.)

### Try this

Open `packages/core/src/events.ts` and scan the union. Every later PR
either emits one of these existing variants or extends the union — the file
is a one-page contract for what can happen during a run.

> Honesty note: `turn:end` is _declared_ in the union but the AgentLoop
> never emits it. `turn:start` is the only turn-boundary event you'll
> see in any real journal. This is consistent across PR02–PR05; flagged
> here so you don't go hunting for it.

## PR02 — ScriptedProvider + minimal AgentLoop

### What this PR added to the harness

A toy `Provider` (`ScriptedProvider`) that returns a pre-canned list of
`Message`s in order, and an `AgentLoop` that drives turns: ask the provider
for a message, journal it, and stop when the assistant returns no tool calls
or `maxTurns` is hit.

There are no tool calls yet — `tool:call` / `tool:result` won't appear until
PR03 wires them in. So the AgentLoop in PR02 produces only `run:start`,
`turn:start`, and `run:end`.

### Walkthrough

The end-to-end runtime test from PR03 prints a journal we can read inline,
but PR02 ships its own AgentLoop tests:

```bash
pnpm --filter @helm/runtime exec vitest run src/agent-loop.test.ts --reporter=verbose
```

The first test, **"runs a simple no-tool turn"**, asserts the journal has
exactly three lines for a single-message script:

```
run:start
turn:start
run:end
```

That's the PR02 minimum: open a run, run one turn, close the run.

### Try this

Look at `packages/runtime/src/agent-loop.ts:30` — the `for` loop that walks
turns. The exit condition `response.toolCalls?.length > 0` is the entire
"agent" decision in PR02: keep going if the assistant asked for tools, stop
if it didn't. PR03 fills in what "asked for tools" actually does.

## PR03 — ToolRuntime

### What this PR added to the harness

A `ToolRuntime` registry and the wiring in AgentLoop that, when an assistant
message has `toolCalls`, journals a `tool:call`, executes the tool, journals
the `tool:result`, and feeds the result back as a `role: "tool"` message.

This is the first PR where the journal really starts to look like an agent
trace: turn → tool:call → tool:result → turn.

### Walkthrough

The `runtime` package ships a printable end-to-end demo test:

```bash
pnpm --filter @helm/runtime exec vitest run src/demo.test.ts --reporter=verbose
```

In the `stdout` block of the test you'll see the journal printed in order:

```
🚀 [hh:mm:ss] RUN START   id=demo-run-1
🔄 [hh:mm:ss] TURN 0 START
🔧 [hh:mm:ss] TOOL CALL   calculator({"expression":"2 + 3 * 4"})
📤 [hh:mm:ss] TOOL RESULT Result: 14
🔄 [hh:mm:ss] TURN 1 START
✅ [hh:mm:ss] RUN END     exitCode=0
Total: 6 events
```

The `tool:call` and `tool:result` events are new in this PR. Note also the
**second** `turn:start` — turn 0 ran the tool, turn 1 asked the provider
again (the assistant now has the tool's output in its message history) and
this time the provider returned a final answer with no `toolCalls`, so the
loop exited.

### Try this

Open `packages/runtime/src/agent-loop.ts:62`. The inner `for (const tc of
response.toolCalls)` loop is what turns one assistant message into N pairs
of `tool:call` / `tool:result` events. `tc.id` is what later turns will use
to match a `role: "tool"` reply back to the right call — same idea as
OpenAI/Anthropic tool-use IDs.

## PR04 — Permission/Risk + minimal CLI

### What this PR added to the harness

Two things landed together in PR04:

1. `PermissionRuntime` with `RiskLevel` (`LOW`, `MEDIUM`, `HIGH`,
   `CRITICAL`), allow/deny rules, and pattern matching (trailing `*` wildcard).
   Wired into `ToolRuntime`: every `execute()` first asks the
   `PermissionRuntime` whether the call is allowed.
2. `packages/cli/bin/run.js` — the first user-runnable surface. It loads a
   tools file, a script file, a perms file, builds a real AgentLoop, and
   tails the journal to stdout in real time.

A denied tool call does **not** crash the run — the `tool:result` event
records the denial as the tool's "output", so the assistant can react to it
in subsequent turns. (No new event variant: permission denial reuses
`tool:result`.)

### Walkthrough — allowed run

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-normal
cat /tmp/helm-walkthrough-normal.jsonl
```

The fixture's `perms.json` allows `calculator` at MEDIUM and `weather` at LOW.
The journal looks like PR03's demo trace — same six events. The new bit lives
inside `ToolRuntime.execute`: before delegating to the tool, it consults the
`PermissionRuntime`. Because the rule is `allow`, you don't see a difference
in the trace. (That's the point — allow is the silent path.)

### Walkthrough — denied run

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms-deny-calc.json \
  walkthrough-deny
cat /tmp/helm-walkthrough-deny.jsonl
```

`perms-deny-calc.json` has both an allow and a deny for `calculator`, with
the deny at CRITICAL risk. Deny wins. The trace's `tool:result` line carries
the rejection:

```json
{"type":"tool:result","runId":"walkthrough-deny","turnIndex":0,"toolName":"calculator",
 "output":"Error: permission denied — Tool \"calculator\" is denied: calculator blocked for demo (risk: CRITICAL)",
 "timestamp":...}
```

The run still ends with `exitCode=0` — permission denial is a tool-level
outcome, not a run-level failure.

### Try this

Open `packages/cli/fixtures/perms-deny-calc.json` and change the deny risk
level to `LOW`, then re-run. The deny still wins regardless of risk level —
risk is metadata recorded with the rule, not part of the precedence logic.
Look at `packages/runtime/src/permission-runtime.ts` to confirm: deny rules
are checked before allow rules, and the risk level is just propagated into
the rejection message.

## PR05 — Cancellation / Timeout

### What this PR added to the harness

- `run:cancelled` event variant with `reason: "external" | "timeout"`.
- Optional `signal?: AbortSignal` on `Tool.execute` and `Provider.send`.
- `AgentLoop` accepts `signal` and `maxDurationMs` options. Internally it
  builds one `AbortController` whose `abort()` is triggered by either the
  external signal or a `setTimeout(maxDurationMs)`. The signal is checked
  at turn boundaries, around `provider.send`, and around each `tool.execute`.
- Cancellation exits with exit code `130` (the SIGINT convention).
- The CLI gains `--timeout=<ms>` and a `SIGINT` handler. There's also an
  undocumented helper flag `--turn-delay-ms=<ms>` that wraps the provider
  in an artificial delay; useful for demoing cancellation against the
  scripted provider, which would otherwise return instantly.

### Walkthrough — normal exit

Same command as PR04's allowed run; we re-run for completeness:

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-normal
echo "exit=$?"   # → 0
```

The trace ends with `run:end exitCode=0`. No `run:cancelled` event.
This confirms the timeout path is not entered when none is configured.

### Walkthrough — timeout

The scripted provider returns immediately, so a timeout has nothing to fire
against unless we slow it down. `--turn-delay-ms` injects 200 ms per
provider call, and `--timeout=50` fires the internal abort after 50 ms:

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-timeout \
  --timeout=50 --turn-delay-ms=200
echo "exit=$?"   # → 130
cat /tmp/helm-walkthrough-timeout.jsonl
```

Trace:

```
run:start
turn:start (turnIndex 0)
run:cancelled reason=timeout
run:end exitCode=130
```

The interrupt landed inside `provider.send` — turn 0 had started but never
finished, which is why there's no `tool:call` for that turn. The abort
listener inside the slow-provider wrapper rejected the in-flight `setTimeout`
with an `AbortError`; AgentLoop saw `controller.signal.aborted` was true
and routed that into a `run:cancelled` event rather than an `error` event.

### Walkthrough — Ctrl-C

In one shell:

```bash
node packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  walkthrough-sigint \
  --turn-delay-ms=2000
```

Press **Ctrl-C** within the first second. You'll see:

```
^C received — cancelling run...
🛑 [hh:mm:ss] CANCELLED    reason=external
✅ [hh:mm:ss] RUN END      exitCode=130
```

`cat /tmp/helm-walkthrough-sigint.jsonl` to confirm the events:

```
run:start
turn:start (turnIndex 0)
run:cancelled reason=external
run:end exitCode=130
```

Same shape as the timeout case but `reason=external`. The CLI's `SIGINT`
handler called `controller.abort()` on its own `AbortController`, which is
passed in as `options.signal` to `AgentLoop` — the loop's internal merged
controller fires, the in-flight provider call rejects, and we land on the
external-cancellation branch.

### Try this

Re-run the timeout case with `--timeout=5` (so the timer fires before the
provider is even called). The `run:cancelled` event still appears, but in
some cases you'll see it _before_ any `turn:start` — the loop's pre-loop
cancellation check (`agent-loop.ts:81`) catches the already-aborted signal
right after `run:start`. Compare that against `--timeout=50
--turn-delay-ms=200`, where you do get a `turn:start` first. That tells you
exactly which boundary check caught the cancel.

## Appendix A — Event type reference

Source of truth: `packages/core/src/events.ts`.

| Event              | PR introduced | Meaning                                                              |
| ------------------ | ------------- | -------------------------------------------------------------------- |
| `run:start`        | PR01          | A run has been opened; first event in every journal                  |
| `run:end`          | PR01          | A run has terminated; carries `exitCode` (0 normal, 130 cancelled)   |
| `turn:start`       | PR01          | An agent turn is beginning; emitted at the top of each loop iter     |
| `turn:end`         | PR01          | _Declared but never emitted_ — see honesty note in PR01 section      |
| `tool:call`        | PR01 (type) / PR03 (emitted) | Assistant requested a tool with these args                          |
| `tool:result`      | PR01 (type) / PR03 (emitted) | Tool returned this output (or a permission-denied message in PR04)  |
| `error`            | PR01 (type) / PR02 (emitted) | Provider threw something not caused by abort                        |
| `run:cancelled`    | PR05          | Run is ending due to external abort or timeout; carries `reason`     |

The exact field shape for each variant is at the top of `events.ts`. There
are no optional schema versioning fields yet — every consumer must accept
all variants or it's a code change in `core`.

## Appendix B — IDE debugging (optional)

Skipped intentionally. The CLI runs from compiled JS under
`packages/cli/dist/bin/run.js`, so a working VS Code launch config would
need either a separate `tsx`/source-map setup or a build-then-attach flow.
Neither is wired up in the repo today, and inventing one untested would
violate the spirit of this guide. If you want a breakpoint in the meantime,
the simplest thing that works is:

```bash
node --inspect-brk packages/cli/dist/bin/run.js \
  packages/cli/fixtures/tools.json \
  packages/cli/fixtures/script.jsonl \
  packages/cli/fixtures/perms.json \
  debug-run
```

then attach VS Code's "Node: Attach" config to `localhost:9229`. Source
maps are emitted by `tsc` because `tsconfig.base.json` is the default,
so breakpoints in `packages/runtime/src/agent-loop.ts` will hit when the
compiled file runs. This works but is not project-wired — adding a real
`.vscode/launch.json` belongs in a future PR after we agree on the
debugging story.

# Helm Project Instructions

This repository is Helm.

Helm is a TypeScript-first Agent Harness learning project.

It is not a Claude Code clone, not a Cursor clone, and not a Codex clone.

The goal is to learn and implement reliable agent infrastructure:

- trace / journal
- replay
- eval harness
- tool runtime
- permission / risk control
- cancellation / timeout
- error taxonomy / retry
- context management
- provider abstraction
- subagent run tree
- MCP integration

## Role Rules

Developer Claude writes code and opens PRs.
Reviewer Claude reviews PRs and does not write feature code.
Admin Claude merges PRs and manages repository settings.

The PR author must not approve their own PR.

## Development Rules

Implement exactly one PR-sized task at a time.
Do not start the next PR unless the user explicitly asks.
Do not implement unrelated features early.

Do not add MCP, subagents, TUI, multiple providers, or advanced compaction unless the current PR explicitly asks for it.

## Early PR Sequence

1. PR00: Bootstrap TypeScript monorepo
2. PR01: RunEvent + JsonlJournal
3. PR02: ScriptedProvider + minimal AgentLoop
4. PR03: ToolRuntime
5. PR04: Permission / Risk
6. PR05: Cancellation / Timeout
7. PR06: Error taxonomy / Retry
8. PR07: Eval Harness
9. PR08: Replay

## Testing Requirements

Every PR must include tests.
Run before reporting done:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Do not rely on real LLM API calls in unit tests.

## Workflow Rule

Claude workflow may be used only for read-only review, architecture critique, and test gap analysis unless the user explicitly authorizes file changes.

## Git Rules

Do not git add, commit, push, merge, reset, clean, or rebase unless the user explicitly authorizes that exact operation.

Before commit, check for:

- .env
- API keys
- SSH private keys
- node_modules
- private control room kit
- real trace/journal logs

## Completion Report

After each implementation step, output:

PRIVATE_NOTE_UPDATE_BEGIN
role:
pr:
status:
summary:
files_changed:
tests_run:
commands_run:
known_risks:
next_recommended_step:
PRIVATE_NOTE_UPDATE_END

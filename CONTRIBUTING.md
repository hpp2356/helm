# Contributing to Helm

Helm uses a PR-based workflow.

## Roles

- Developer: writes code and opens PRs.
- Reviewer: reviews PRs and may request changes or approve.
- Admin: manages repository settings, merges PRs, and releases.

## Branch Naming

Use:

- feat/prXX-short-name
- fix/prXX-short-name
- chore/prXX-short-name
- docs/prXX-short-name

Example:

```text
feat/pr01-run-event-journal
```

## Commit Messages

Use Conventional Commits:

```text
type(scope): summary
```

Examples:

```text
chore(monorepo): bootstrap TypeScript workspace
feat(trace): add JSONL run journal
fix(runtime): propagate cancellation to tool calls
```

## Pull Requests

Each PR should be small and focused.

Before opening PR:

```bash
pnpm typecheck
pnpm test
pnpm build
```

PRs should not contain secrets, .env files, node_modules, or local run logs.

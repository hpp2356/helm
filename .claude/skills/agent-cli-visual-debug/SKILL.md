---
description: Debug and improve the target Agent CLI terminal UI using screenshot-based visual feedback, terminal snapshots, and repeated verification.
---

You are debugging the target Agent CLI, not Claude Code's own interface.

Always use a visual feedback loop for CLI style changes:

1. Launch the target CLI using the project's documented command.
2. Capture the rendered terminal UI using available tools:
   - Prefer /screenshot window if the CLI is running in another terminal window.
   - Prefer terminal screenshot/rendering tools for ANSI-heavy output.
   - Prefer VHS snapshots for deterministic flows and regression checks.
3. Inspect actual rendered output, not just source code:
   - layout
   - alignment
   - wrapping
   - color contrast
   - status bars
   - loading states
   - error states
   - markdown/code block rendering
   - narrow terminal sizes such as 60x20
4. Make code changes.
5. Run typecheck, lint, tests, and the CLI manually.
6. Capture again and compare with the previous screenshot.
7. Summarize:
   - fixed visual issues
   - remaining visual issues
   - files changed
   - verification commands run

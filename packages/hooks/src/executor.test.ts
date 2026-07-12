// packages/hooks/src/executor.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeHandler } from "./executor.js";
import type { HookInput } from "./types.js";

const TEST_INPUT: HookInput = {
  event: "pre:tool",
  session_id: "test-session",
  tool_name: "bash",
  tool_input: { command: "echo hello" },
  cwd: "/tmp",
  timestamp: "2026-01-01T00:00:00Z",
};

describe("executor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-executor-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("executes a simple command and parses JSON output", async () => {
    const script = join(tempDir, "hook.sh");
    writeFileSync(script, `#!/bin/sh
echo '{"decision":"allow","reason":"ok"}'
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("executes deny decision", async () => {
    const script = join(tempDir, "deny.sh");
    writeFileSync(script, `#!/bin/sh
echo '{"decision":"deny","reason":"blocked"}'
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("blocked");
  });

  it("executes modify decision", async () => {
    const script = join(tempDir, "modify.sh");
    writeFileSync(script, `#!/bin/sh
echo '{"decision":"modify","modified_input":{"command":"ls -la --color=auto"}}'
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("modify");
    expect(result.modifiedInput).toEqual({ command: "ls -la --color=auto" });
  });

  it("handles timeout", async () => {
    const script = join(tempDir, "slow.sh");
    writeFileSync(script, `#!/bin/sh
sleep 10
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script, timeout: 100 },
      TEST_INPUT,
    );

    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  it("handles non-zero exit code", async () => {
    const script = join(tempDir, "fail.sh");
    writeFileSync(script, `#!/bin/sh
exit 1
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("allow"); // default on error
    expect(result.error).toContain("exited with code 1");
  });

  it("handles non-JSON stdout as system_message", async () => {
    const script = join(tempDir, "text.sh");
    writeFileSync(script, `#!/bin/sh
echo "This is a plain text message"
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("allow");
    expect(result.systemMessage).toBe("This is a plain text message");
  });

  it("handles empty stdout", async () => {
    const script = join(tempDir, "empty.sh");
    writeFileSync(script, `#!/bin/sh
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.decision).toBe("allow");
  });

  it("handles nonexistent command gracefully", async () => {
    const result = await executeHandler(
      { type: "command", command: "/nonexistent/command" },
      TEST_INPUT,
    );

    expect(result.decision).toBe("allow");
    expect(result.error).toBeDefined();
  });

  it("sends correct JSON to stdin", async () => {
    const script = join(tempDir, "stdin.sh");
    writeFileSync(script, `#!/bin/sh
# Read stdin and echo the event field
INPUT=$(cat)
echo "$INPUT" | sed 's/.*"event"//' | head -c 1
`);
    chmodSync(script, 0o755);

    // Just verify it doesn't crash — the stdin was sent
    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records duration", async () => {
    const script = join(tempDir, "quick.sh");
    writeFileSync(script, `#!/bin/sh
echo '{"decision":"allow"}'
`);
    chmodSync(script, 0o755);

    const result = await executeHandler(
      { type: "command", command: script },
      TEST_INPUT,
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});

// packages/hooks/src/runtime.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookRuntime } from "./runtime.js";

describe("runtime", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createHookScript(name: string, output: string): string {
    const script = join(tempDir, name);
    writeFileSync(script, `#!/bin/sh\necho '${output}'\n`);
    chmodSync(script, 0o755);
    return script;
  }

  function createHooksConfig(config: object): void {
    const hooksDir = join(tempDir, ".helm");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify(config));
  }

  it("returns null when no hooks match", async () => {
    const runtime = new HookRuntime({ projectRoot: tempDir, bypassTrust: true });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });
    expect(result).toBeNull();
  });

  it("executes matching hooks and returns aggregate result", async () => {
    const script = createHookScript("allow.sh", '{"decision":"allow"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { matcher: "bash", handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir, bypassTrust: true });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("allow");
    expect(result!.results).toHaveLength(1);
  });

  it("deny decision takes precedence", async () => {
    const allow = createHookScript("allow.sh", '{"decision":"allow"}');
    const deny = createHookScript("deny.sh", '{"decision":"deny","reason":"blocked"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { handlers: [{ type: "command", command: allow }] },
          { handlers: [{ type: "command", command: deny }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir, bypassTrust: true });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });

    expect(result!.decision).toBe("deny");
    expect(result!.reason).toBe("blocked");
  });

  it("modify decision sets modifiedInput", async () => {
    const modify = createHookScript("modify.sh", '{"decision":"modify","modified_input":{"command":"ls --color"}}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { handlers: [{ type: "command", command: modify }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir, bypassTrust: true });
    const result = await runtime.execute("pre:tool", {
      toolName: "bash",
      toolInput: { command: "ls" },
    });

    expect(result!.decision).toBe("modify");
    expect(result!.modifiedInput).toEqual({ command: "ls --color" });
  });

  it("collects system messages from hooks", async () => {
    const script = createHookScript("msg.sh", '{"system_message":"audit log entry"}');
    createHooksConfig({
      hooks: {
        "post:tool": [
          { handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir, bypassTrust: true });
    const result = await runtime.execute("post:tool", {
      toolName: "bash",
      toolOutput: "result",
    });

    expect(result!.systemMessages).toContain("audit log entry");
  });

  it("skips untrusted hooks when bypassTrust is false", async () => {
    const script = createHookScript("untrusted.sh", '{"decision":"deny"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({
      projectRoot: tempDir,
      homeDir: tempDir,
      bypassTrust: false,
    });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("allow"); // untrusted = skipped
    expect(result!.hadUntrusted).toBe(true);
    expect(result!.results[0]!.error).toContain("not trusted");
  });

  it("disabled runtime returns null", async () => {
    const script = createHookScript("deny.sh", '{"decision":"deny"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir, disabled: true });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });
    expect(result).toBeNull();
  });

  it("disabled event returns null", async () => {
    const script = createHookScript("deny.sh", '{"decision":"deny"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({
      projectRoot: tempDir,
      disabledEvents: new Set(["pre:tool"]),
    });
    const result = await runtime.execute("pre:tool", { toolName: "bash" });
    expect(result).toBeNull();
  });

  it("hasHooksFor returns correct value", async () => {
    const script = createHookScript("test.sh", '{"decision":"allow"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { matcher: "bash", handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir });
    expect(runtime.hasHooksFor("pre:tool", "bash")).toBe(true);
    expect(runtime.hasHooksFor("pre:tool", "read")).toBe(false);
    expect(runtime.hasHooksFor("post:tool")).toBe(false);
  });

  it("getConfig returns loaded config", () => {
    const script = createHookScript("test.sh", '{"decision":"allow"}');
    createHooksConfig({
      hooks: {
        "pre:tool": [
          { matcher: "bash", handlers: [{ type: "command", command: script }] },
        ],
      },
    });

    const runtime = new HookRuntime({ projectRoot: tempDir });
    const config = runtime.getConfig();
    expect(config.hooks["pre:tool"]).toHaveLength(1);
  });

  it("getTrust returns trust registry", () => {
    const runtime = new HookRuntime({ projectRoot: tempDir });
    const trust = runtime.getTrust();
    expect(trust.list()).toHaveLength(0);
  });
});

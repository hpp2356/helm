import { describe, it, expect } from "vitest";
import { createBashTool, registerBashTool } from "./bash-tool.js";
import { BashSafety } from "./bash-safety.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { ToolRuntime } from "./tool-runtime.js";
import { PermissionRuntime } from "./permission-runtime.js";
import { RiskLevel } from "@helm/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function setupWorkspace(): { dir: string; guard: WorkspaceGuard; safety: BashSafety } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bt-"));
  const guard = new WorkspaceGuard(dir);
  const safety = new BashSafety(guard);
  return { dir, guard, safety };
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── bash tool ───────────────────────────────────────────────────────────────

describe("bash tool", () => {
  it("executes a simple command and captures stdout", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "echo hello world" });
      const parsed = JSON.parse(result);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.trim()).toBe("hello world");
      expect(parsed.stderr).toBe("");
    } finally {
      cleanup(dir);
    }
  });

  it("captures stderr on command failure", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "ls nonexistent-path-dir" });
      const parsed = JSON.parse(result);
      expect(parsed.exitCode).not.toBe(0);
      expect(parsed.stderr.length).toBeGreaterThan(0);
    } finally {
      cleanup(dir);
    }
  });

  it("works in workspace directory by default", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "test.txt"), "test content");
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "cat test.txt" });
      const parsed = JSON.parse(result);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.trim()).toBe("test content");
    } finally {
      cleanup(dir);
    }
  });

  it("respects cwd option", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const subDir = path.join(dir, "sub");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "nested.txt"), "nested");
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "cat nested.txt", cwd: "sub" });
      const parsed = JSON.parse(result);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.trim()).toBe("nested");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects cwd outside workspace", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "ls", cwd: "../outside" });
      expect(result).toContain("Workspace escape blocked");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects cwd that is not a directory", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "a-file.txt"), "data");
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "ls", cwd: "a-file.txt" });
      expect(result).toContain("not a directory");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects cwd that does not exist", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "ls", cwd: "nowhere" });
      expect(result).toContain("not found");
    } finally {
      cleanup(dir);
    }
  });

  it("blocks dangerous command by BashSafety", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "sudo rm -rf /" });
      expect(result).toContain("command blocked by safety");
    } finally {
      cleanup(dir);
    }
  });

  it("kills command after timeout", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({
        command: "sleep 10",
        timeout: 500,
      });
      const parsed = JSON.parse(result);
      expect(parsed.killed).toBe(true);
      expect(parsed.exitCode).not.toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("handles external signal cancellation", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const controller = new AbortController();
      // Abort immediately
      controller.abort();
      const result = await tool.execute(
        { command: "sleep 5" },
        controller.signal,
      );
      const parsed = JSON.parse(result);
      expect(parsed.killed).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("merges env variables with defaults", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({
        command: "echo $HELM_TEST_VAR",
        env: { HELM_TEST_VAR: "custom-value" },
      });
      const parsed = JSON.parse(result);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.trim()).toBe("custom-value");
    } finally {
      cleanup(dir);
    }
  });

  it("returns error for empty command", async () => {
    const { dir, guard, safety } = setupWorkspace();
    try {
      const tool = createBashTool({ guard, safety, workspaceRoot: dir });
      const result = await tool.execute({ command: "" });
      expect(result).toContain("Error: command is required");
    } finally {
      cleanup(dir);
    }
  });

  // ── Integration ───────────────────────────────────────────────────────

  it("registers on ToolRuntime and is callable", async () => {
    const { dir } = setupWorkspace();
    try {
      const tr = new ToolRuntime();
      registerBashTool(tr, dir);
      expect(tr.has("bash")).toBe(true);
      expect(tr.list()).toHaveLength(1);

      const result = await tr.execute("bash", { command: "echo test" });
      const parsed = JSON.parse(result);
      expect(parsed.stdout.trim()).toBe("test");
    } finally {
      cleanup(dir);
    }
  });

  it("is blocked by PermissionRuntime", async () => {
    const { dir } = setupWorkspace();
    try {
      const pr = new PermissionRuntime();
      pr.deny({
        pattern: "bash",
        riskLevel: RiskLevel.CRITICAL,
        description: "no bash allowed",
      });

      const tr = new ToolRuntime(pr);
      registerBashTool(tr, dir);

      const result = await tr.execute("bash", { command: "echo test" });
      expect(result).toContain("permission denied");
      expect(result).toContain("no bash allowed");
    } finally {
      cleanup(dir);
    }
  });
});

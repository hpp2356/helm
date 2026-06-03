import { describe, it, expect } from "vitest";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
  createGlobTool,
  registerFileTools,
} from "./file-tools.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { ToolRuntime } from "./tool-runtime.js";
import { PermissionRuntime } from "./permission-runtime.js";
import { RiskLevel } from "@helm/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function setupWorkspace(): { dir: string; guard: WorkspaceGuard } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ft-"));
  const guard = new WorkspaceGuard(dir);
  return { dir, guard };
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── read ──────────────────────────────────────────────────────────────────

describe("read tool", () => {
  it("reads an existing file", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "hello.txt"), "Hello\nWorld\n");
      const tool = createReadTool({ guard });
      const result = await tool.execute({ filePath: "hello.txt" });
      const parsed = JSON.parse(result);
      expect(parsed.content).toBe("Hello\nWorld\n");
      expect(parsed.totalLines).toBe(3);
      expect(parsed.path).toBe("hello.txt");
    } finally {
      cleanup(dir);
    }
  });

  it("returns error for non-existent file", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createReadTool({ guard });
      const result = await tool.execute({ filePath: "nonexistent.txt" });
      expect(result).toContain("Error: file not found");
    } finally {
      cleanup(dir);
    }
  });

  it("supports offset and limit", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(
        path.join(dir, "nums.txt"),
        "1\n2\n3\n4\n5\n",
      );
      const tool = createReadTool({ guard });
      const result = await tool.execute({
        filePath: "nums.txt",
        offset: 2,
        limit: 2,
      });
      const parsed = JSON.parse(result);
      expect(parsed.content).toBe("2\n3");
      expect(parsed.totalLines).toBe(6); // trailing newline = 6th empty line
    } finally {
      cleanup(dir);
    }
  });

  it("rejects binary file", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const buf = Buffer.alloc(10);
      buf[5] = 0; // null byte
      fs.writeFileSync(path.join(dir, "bin.bin"), buf);
      const tool = createReadTool({ guard });
      const result = await tool.execute({ filePath: "bin.bin" });
      expect(result).toContain("binary");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects directory", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.mkdirSync(path.join(dir, "subdir"));
      const tool = createReadTool({ guard });
      const result = await tool.execute({ filePath: "subdir" });
      expect(result).toContain("not a file");
    } finally {
      cleanup(dir);
    }
  });
});

// ── write ─────────────────────────────────────────────────────────────────

describe("write tool", () => {
  it("creates a new file with content", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createWriteTool({ guard });
      const result = await tool.execute({
        filePath: "out.txt",
        content: "new content",
      });
      const parsed = JSON.parse(result);
      expect(parsed.path).toBe("out.txt");
      expect(parsed.bytesWritten).toBeGreaterThan(0);

      const written = fs.readFileSync(path.join(dir, "out.txt"), "utf-8");
      expect(written).toBe("new content");
    } finally {
      cleanup(dir);
    }
  });

  it("overwrites an existing file", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "out.txt"), "original");
      const tool = createWriteTool({ guard });
      await tool.execute({ filePath: "out.txt", content: "replaced" });
      const written = fs.readFileSync(path.join(dir, "out.txt"), "utf-8");
      expect(written).toBe("replaced");
    } finally {
      cleanup(dir);
    }
  });

  it("auto-creates parent directories", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createWriteTool({ guard });
      const result = await tool.execute({
        filePath: "deep/nested/file.txt",
        content: "deep",
      });
      const parsed = JSON.parse(result);
      expect(parsed.path).toBe("deep/nested/file.txt");
      expect(fs.existsSync(path.join(dir, "deep", "nested", "file.txt"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects write outside workspace", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createWriteTool({ guard });
      const result = await tool.execute({
        filePath: "../escape.txt",
        content: "bad",
      });
      expect(result).toContain("Workspace escape blocked");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects directory path", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.mkdirSync(path.join(dir, "adir"));
      const tool = createWriteTool({ guard });
      const result = await tool.execute({
        filePath: "adir",
        content: "bad",
      });
      expect(result).toContain("is a directory");
    } finally {
      cleanup(dir);
    }
  });
});

// ── edit ──────────────────────────────────────────────────────────────────

describe("edit tool", () => {
  it("replaces a unique match", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "file.txt"), "Hello World");
      const tool = createEditTool({ guard });
      const result = await tool.execute({
        filePath: "file.txt",
        oldString: "World",
        newString: "Earth",
      });
      const parsed = JSON.parse(result);
      expect(parsed.replaced).toBe(true);
      expect(parsed.matchCount).toBe(1);

      const content = fs.readFileSync(path.join(dir, "file.txt"), "utf-8");
      expect(content).toBe("Hello Earth");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects when oldString not found", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "file.txt"), "Hello World");
      const tool = createEditTool({ guard });
      const result = await tool.execute({
        filePath: "file.txt",
        oldString: "NotThere",
        newString: "X",
      });
      expect(result).toContain("string not found");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects multiple matches without replaceAll", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(
        path.join(dir, "file.txt"),
        "foo bar foo baz foo",
      );
      const tool = createEditTool({ guard });
      const result = await tool.execute({
        filePath: "file.txt",
        oldString: "foo",
        newString: "qux",
      });
      expect(result).toContain("found 3 matches");
      expect(result).toContain("replaceAll");
    } finally {
      cleanup(dir);
    }
  });

  it("replaces all matches with replaceAll", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(
        path.join(dir, "file.txt"),
        "foo bar foo baz foo",
      );
      const tool = createEditTool({ guard });
      const result = await tool.execute({
        filePath: "file.txt",
        oldString: "foo",
        newString: "qux",
        replaceAll: true,
      });
      const parsed = JSON.parse(result);
      expect(parsed.replaced).toBe(true);
      expect(parsed.matchCount).toBe(3);

      const content = fs.readFileSync(path.join(dir, "file.txt"), "utf-8");
      expect(content).toBe("qux bar qux baz qux");
    } finally {
      cleanup(dir);
    }
  });

  it("returns file not found error", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createEditTool({ guard });
      const result = await tool.execute({
        filePath: "nonexistent.txt",
        oldString: "x",
        newString: "y",
      });
      expect(result).toContain("file not found");
    } finally {
      cleanup(dir);
    }
  });
});

// ── ls ────────────────────────────────────────────────────────────────────

describe("ls tool", () => {
  it("lists directory contents", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      fs.writeFileSync(path.join(dir, "b.txt"), "b");
      fs.mkdirSync(path.join(dir, "sub"));

      const tool = createLsTool({ guard });
      const result = await tool.execute({ dirPath: "." });
      const parsed = JSON.parse(result);
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.path).toBe(".");

      const names = parsed.entries.map(
        (e: { name: string }) => e.name,
      );
      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
      expect(names).toContain("sub");
    } finally {
      cleanup(dir);
    }
  });

  it("returns error for non-existent directory", async () => {
    const { guard } = setupWorkspace();
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ft2-"));
    try {
      const tool = createLsTool({ guard });
      const result = await tool.execute({ dirPath: "nope" });
      expect(result).toContain("directory not found");
    } finally {
      cleanup(dir2);
    }
  });

  it("returns error for file path", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "file.txt"), "data");
      const tool = createLsTool({ guard });
      const result = await tool.execute({ dirPath: "file.txt" });
      expect(result).toContain("not a directory");
    } finally {
      cleanup(dir);
    }
  });

  it("defaults to workspace root", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "x.txt"), "x");
      const tool = createLsTool({ guard });
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup(dir);
    }
  });
});

// ── glob ──────────────────────────────────────────────────────────────────

describe("glob tool", () => {
  it("finds files by extension pattern", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "ts");
      fs.writeFileSync(path.join(dir, "b.ts"), "ts");
      fs.writeFileSync(path.join(dir, "c.js"), "js");

      const tool = createGlobTool({ guard });
      const result = await tool.execute({ pattern: "*.ts" });
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(2);
      expect(parsed.matches).toContain("a.ts");
      expect(parsed.matches).toContain("b.ts");
    } finally {
      cleanup(dir);
    }
  });

  it("finds files recursively with **", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "a.ts"), "a");
      fs.writeFileSync(path.join(dir, "sub", "b.ts"), "b");

      const tool = createGlobTool({ guard });
      const result = await tool.execute({ pattern: "**/*.ts" });
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(2);
    } finally {
      cleanup(dir);
    }
  });

  it("returns empty matches for no results", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const tool = createGlobTool({ guard });
      const result = await tool.execute({ pattern: "*.xyz" });
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(0);
      expect(parsed.matches).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it("respects dirPath option", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      fs.mkdirSync(path.join(dir, "lib"));
      fs.writeFileSync(path.join(dir, "root.ts"), "root");
      fs.writeFileSync(path.join(dir, "lib", "lib.ts"), "lib");

      const tool = createGlobTool({ guard });
      const result = await tool.execute({
        pattern: "*.ts",
        dirPath: "lib",
      });
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(1);
      expect(parsed.matches).toContain("lib/lib.ts");
    } finally {
      cleanup(dir);
    }
  });
});

// ── registerFileTools ─────────────────────────────────────────────────────

describe("registerFileTools", () => {
  it("registers all 5 tools on ToolRuntime", () => {
    const tr = new ToolRuntime();
    const { dir } = setupWorkspace();
    try {
      const guard = registerFileTools(tr, dir);
      expect(guard).toBeInstanceOf(WorkspaceGuard);
      expect(tr.has("read")).toBe(true);
      expect(tr.has("write")).toBe(true);
      expect(tr.has("edit")).toBe(true);
      expect(tr.has("ls")).toBe(true);
      expect(tr.has("glob")).toBe(true);
      expect(tr.list()).toHaveLength(5);
    } finally {
      cleanup(dir);
    }
  });

  it("integrated with AgentLoop — read and write via tool calls", async () => {
    // Import dynamically to avoid circular
    const { ScriptedProvider } = await import("./scripted-provider.js");
    const { AgentLoop } = await import("./agent-loop.js");
    const { JsonlJournal } = await import("@helm/core");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "helm-ft-int-"));
    const journalPath = join(dir, "journal.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.open();

    const tr = new ToolRuntime();
    const guard = registerFileTools(tr, dir);

    // First turn: write a file, second turn: read it back
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "writing file",
        toolCalls: [
          {
            id: "1",
            name: "write",
            args: { filePath: "hello.txt", content: "Hello from agent" },
          },
        ],
      },
      {
        role: "assistant",
        content: "reading file",
        toolCalls: [
          {
            id: "2",
            name: "read",
            args: { filePath: "hello.txt" },
          },
        ],
      },
      { role: "assistant", content: "All done!" },
    ]);

    const loop = new AgentLoop(provider, tr, journal, { maxTurns: 5 });
    const result = await loop.run("int-test", "Write and read a file");
    await journal.close();

    expect(result.exitCode).toBe(0);

    const events = (await readFile(journalPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const writeCalls = events.filter(
      (e: { type: string; toolName?: string }) =>
        e.type === "tool:call" && e.toolName === "write",
    );
    const readCalls = events.filter(
      (e: { type: string; toolName?: string }) =>
        e.type === "tool:call" && e.toolName === "read",
    );
    expect(writeCalls.length).toBe(1);
    expect(readCalls.length).toBe(1);

    // Verify the file actually exists
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(join(dir, "hello.txt"));
    expect(fileStat.isFile()).toBe(true);

    // clean up the workspace dir — use native fs for sync
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tool blocked by PermissionRuntime is denied", async () => {
    const { dir, guard } = setupWorkspace();
    try {
      const pr = new PermissionRuntime();
      pr.deny({
        pattern: "write",
        riskLevel: RiskLevel.HIGH,
        description: "no writes allowed",
      });

      const tr = new ToolRuntime(pr);
      registerFileTools(tr, dir);

      const result = await tr.execute("write", {
        filePath: "test.txt",
        content: "blocked",
      });
      expect(result).toContain("permission denied");
      expect(result).toContain("no writes allowed");
    } finally {
      cleanup(dir);
    }
  });
});

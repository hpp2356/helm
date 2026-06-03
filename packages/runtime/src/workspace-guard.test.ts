import { describe, it, expect } from "vitest";
import { WorkspaceGuard } from "./workspace-guard.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("WorkspaceGuard", () => {
  let tmpDir: string;
  let guard: WorkspaceGuard;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-wsguard-"));
    guard = new WorkspaceGuard(tmpDir);
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it("allows path inside root", () => {
    setup();
    try {
      fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello");
      const resolved = guard.validate("test.txt");
      expect(resolved).toBe(path.join(tmpDir, "test.txt"));
    } finally {
      cleanup();
    }
  });

  it("allows nested path inside root", () => {
    setup();
    try {
      fs.mkdirSync(path.join(tmpDir, "sub"));
      fs.writeFileSync(path.join(tmpDir, "sub", "nested.txt"), "data");
      const resolved = guard.validate("sub/nested.txt");
      expect(resolved).toBe(path.join(tmpDir, "sub", "nested.txt"));
    } finally {
      cleanup();
    }
  });

  it("rejects path with ../ escape", () => {
    setup();
    try {
      expect(() => guard.validate("../etc/passwd")).toThrow(
        "Workspace escape blocked",
      );
    } finally {
      cleanup();
    }
  });

  it("rejects absolute path outside root", () => {
    setup();
    try {
      expect(() => guard.validate("/etc/passwd")).toThrow(
        "Workspace escape blocked",
      );
    } finally {
      cleanup();
    }
  });

  it("rejects symlink pointing outside workspace", () => {
    setup();
    try {
      const outsideTarget = path.join(os.tmpdir(), "helm-outside-target.txt");
      fs.writeFileSync(outsideTarget, "escape");

      const symlinkPath = path.join(tmpDir, "escape-link");
      fs.symlinkSync(outsideTarget, symlinkPath);

      expect(() => guard.validate("escape-link")).toThrow(
        "Workspace escape blocked",
      );
      fs.unlinkSync(outsideTarget);
    } finally {
      cleanup();
    }
  });

  it("allows symlink pointing inside workspace", () => {
    setup();
    try {
      const target = path.join(tmpDir, "real-file.txt");
      fs.writeFileSync(target, "safe");
      fs.symlinkSync(target, path.join(tmpDir, "link-to-real"));

      const resolved = guard.validate("link-to-real");
      expect(resolved).toBe(path.join(tmpDir, "link-to-real"));
    } finally {
      cleanup();
    }
  });

  it("allows path to non-existent file for writing", () => {
    setup();
    try {
      const resolved = guard.validate("new-file.txt");
      expect(resolved).toBe(path.join(tmpDir, "new-file.txt"));
    } finally {
      cleanup();
    }
  });

  it("allows non-existent path when ancestors exist (for write)", () => {
    setup();
    try {
      // The parent doesn't exist yet, but tmp dir exists — guard walks up
      // to find the nearest real ancestor (the workspace root), resolves it,
      // then appends the missing segments.
      const resolved = guard.validate("new-subdir/file.txt");
      expect(resolved).toBe(path.join(tmpDir, "new-subdir", "file.txt"));
    } finally {
      cleanup();
    }
  });

  it("rejects path when escaping via non-existent parent", () => {
    setup();
    try {
      // Workspace root is tmpDir; we try to escape by going above it
      // then into a non-existent dir that would be outside
      expect(() => guard.validate("../../outside/file.txt")).toThrow();
    } finally {
      cleanup();
    }
  });

  it("root resolve is canonical", () => {
    setup();
    try {
      // Create a subdir and go through it
      fs.mkdirSync(path.join(tmpDir, "sub"));
      const resolved = guard.validate("sub/../test.txt");
      expect(resolved).toBe(path.join(tmpDir, "test.txt"));
    } finally {
      cleanup();
    }
  });
});

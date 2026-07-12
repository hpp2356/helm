// packages/hooks/src/trust.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrustRegistry, hashCommand } from "./trust.js";

describe("trust", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "helm-trust-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("TrustRegistry", () => {
    it("starts with no trusted commands", () => {
      const reg = new TrustRegistry(tempDir);
      expect(reg.isTrusted("./hook.sh")).toBe(false);
    });

    it("trusts a command after trust()", () => {
      const script = join(tempDir, "hook.sh");
      writeFileSync(script, "#!/bin/sh\necho ok\n");

      const reg = new TrustRegistry(tempDir);
      reg.trust(script);

      expect(reg.isTrusted(script)).toBe(true);
    });

    it("untrusts a command after untrust()", () => {
      const script = join(tempDir, "hook.sh");
      writeFileSync(script, "#!/bin/sh\necho ok\n");

      const reg = new TrustRegistry(tempDir);
      reg.trust(script);
      expect(reg.isTrusted(script)).toBe(true);

      reg.untrust(script);
      expect(reg.isTrusted(script)).toBe(false);
    });

    it("detects file content change", () => {
      const script = join(tempDir, "hook.sh");
      writeFileSync(script, "#!/bin/sh\necho ok\n");

      const reg = new TrustRegistry(tempDir);
      reg.trust(script);
      expect(reg.isTrusted(script)).toBe(true);

      // Change the file content
      writeFileSync(script, "#!/bin/sh\necho modified\n");
      expect(reg.isTrusted(script)).toBe(false);
    });

    it("persists trust across instances", () => {
      const script = join(tempDir, "hook.sh");
      writeFileSync(script, "#!/bin/sh\necho ok\n");

      const reg1 = new TrustRegistry(tempDir);
      reg1.trust(script);

      // Create a new instance — should load from file
      const reg2 = new TrustRegistry(tempDir);
      expect(reg2.isTrusted(script)).toBe(true);
    });

    it("lists all trust entries", () => {
      const script1 = join(tempDir, "a.sh");
      const script2 = join(tempDir, "b.sh");
      writeFileSync(script1, "#!/bin/sh\necho a\n");
      writeFileSync(script2, "#!/bin/sh\necho b\n");

      const reg = new TrustRegistry(tempDir);
      reg.trust(script1);
      reg.trust(script2);

      const entries = reg.list();
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.trusted)).toBe(true);
    });

    it("handles corrupted trust file gracefully", () => {
      const helmDir = join(tempDir, ".helm");
      const { mkdirSync } = require("node:fs");
      mkdirSync(helmDir, { recursive: true });
      writeFileSync(join(helmDir, "trust.json"), "not json!!!");

      const reg = new TrustRegistry(tempDir);
      expect(reg.list()).toHaveLength(0);
    });
  });

  describe("hashCommand", () => {
    it("returns consistent hash for same file", () => {
      const script = join(tempDir, "test.sh");
      writeFileSync(script, "#!/bin/sh\necho hello\n");

      const h1 = hashCommand(script);
      const h2 = hashCommand(script);
      expect(h1).toBe(h2);
    });

    it("returns different hash for different content", () => {
      const s1 = join(tempDir, "a.sh");
      const s2 = join(tempDir, "b.sh");
      writeFileSync(s1, "#!/bin/sh\necho a\n");
      writeFileSync(s2, "#!/bin/sh\necho b\n");

      expect(hashCommand(s1)).not.toBe(hashCommand(s2));
    });

    it("falls back to hashing command string for non-files", () => {
      const h = hashCommand("echo hello");
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it("returns 16-char hex string", () => {
      const h = hashCommand("test");
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});

// packages/hooks/src/matcher.test.ts

import { describe, it, expect } from "vitest";
import { matchesTool, getMatchingRules } from "./matcher.js";
import type { HookConfig } from "./types.js";

describe("matcher", () => {
  describe("matchesTool", () => {
    it("matches when matcher is undefined", () => {
      expect(matchesTool(undefined, "bash")).toBe(true);
    });

    it("matches when matcher is *", () => {
      expect(matchesTool("*", "bash")).toBe(true);
    });

    it("matches exact string", () => {
      expect(matchesTool("bash", "bash")).toBe(true);
    });

    it("does not match different string", () => {
      expect(matchesTool("bash", "read")).toBe(false);
    });

    it("matches regex pattern", () => {
      expect(matchesTool("ba.*", "bash")).toBe(true);
    });

    it("does not match non-matching regex", () => {
      expect(matchesTool("^read$", "bash")).toBe(false);
    });

    it("handles invalid regex as literal match", () => {
      expect(matchesTool("[invalid", "bash")).toBe(false);
      expect(matchesTool("[invalid", "[invalid")).toBe(true);
    });
  });

  describe("getMatchingRules", () => {
    const config: HookConfig = {
      hooks: {
        "pre:tool": [
          { matcher: "bash", handlers: [{ type: "command", command: "/a" }] },
          { matcher: ".*", handlers: [{ type: "command", command: "/b" }] },
        ],
        "post:tool": [
          { handlers: [{ type: "command", command: "/c" }] },
        ],
      },
    };

    it("returns matching rules for event + tool", () => {
      const rules = getMatchingRules(config, "pre:tool", "bash");
      expect(rules).toHaveLength(2);
    });

    it("returns only regex-matching rules for different tool", () => {
      const rules = getMatchingRules(config, "pre:tool", "read");
      expect(rules).toHaveLength(1);
      expect(rules[0]!.handlers[0]!.command).toBe("/b");
    });

    it("returns empty for event with no rules", () => {
      const rules = getMatchingRules(config, "session:start");
      expect(rules).toHaveLength(0);
    });

    it("returns all rules when no toolName (non-tool event)", () => {
      const rules = getMatchingRules(config, "post:tool");
      expect(rules).toHaveLength(1);
    });
  });
});

// packages/prompt/src/variable-registry.test.ts

import { describe, it, expect } from "vitest";
import {
  VariableRegistry,
  registerBuiltinVariables,
  parseCliVariable,
} from "./variable-registry.js";
import { VariableSource } from "./types.js";

describe("variable-registry", () => {
  describe("VariableRegistry", () => {
    it("sets and gets a variable", () => {
      const reg = new VariableRegistry();
      reg.set("name", "Helm", VariableSource.BUILTIN);
      expect(reg.get("name")).toBe("Helm");
    });

    it("returns undefined for missing variable", () => {
      const reg = new VariableRegistry();
      expect(reg.get("missing")).toBeUndefined();
    });

    it("reports has() correctly", () => {
      const reg = new VariableRegistry();
      expect(reg.has("name")).toBe(false);
      reg.set("name", "Helm", VariableSource.BUILTIN);
      expect(reg.has("name")).toBe(true);
    });

    it("higher priority overrides lower", () => {
      const reg = new VariableRegistry();
      reg.set("name", "Default", VariableSource.BUILTIN);
      reg.set("name", "Override", VariableSource.CLI_FLAG);
      expect(reg.get("name")).toBe("Override");
    });

    it("same priority overrides (last wins)", () => {
      const reg = new VariableRegistry();
      reg.set("name", "First", VariableSource.BUILTIN);
      reg.set("name", "Second", VariableSource.BUILTIN);
      expect(reg.get("name")).toBe("Second");
    });

    it("lower priority does NOT override higher", () => {
      const reg = new VariableRegistry();
      reg.set("name", "CLI", VariableSource.CLI_FLAG);
      reg.set("name", "Builtin", VariableSource.BUILTIN);
      expect(reg.get("name")).toBe("CLI");
    });

    it("toRecord returns all variables", () => {
      const reg = new VariableRegistry();
      reg.set("a", "1", VariableSource.BUILTIN);
      reg.set("b", "2", VariableSource.CLI_FLAG);
      expect(reg.toRecord()).toEqual({ a: "1", b: "2" });
    });

    it("getSource returns correct source", () => {
      const reg = new VariableRegistry();
      reg.set("key", "val", VariableSource.PROJECT_FILE);
      expect(reg.getSource("key")).toBe(VariableSource.PROJECT_FILE);
    });

    it("merge combines registries respecting priority", () => {
      const reg1 = new VariableRegistry();
      reg1.set("a", "high", VariableSource.CLI_FLAG);

      const reg2 = new VariableRegistry();
      reg2.set("a", "low", VariableSource.BUILTIN);
      reg2.set("b", "new", VariableSource.GLOBAL_FILE);

      reg1.merge(reg2);
      expect(reg1.get("a")).toBe("high"); // CLI_FLAG > BUILTIN
      expect(reg1.get("b")).toBe("new");
    });

    it("names returns all keys", () => {
      const reg = new VariableRegistry();
      reg.set("x", "1", VariableSource.BUILTIN);
      reg.set("y", "2", VariableSource.BUILTIN);
      expect(reg.names()).toEqual(expect.arrayContaining(["x", "y"]));
    });

    it("clear removes all variables", () => {
      const reg = new VariableRegistry();
      reg.set("a", "1", VariableSource.BUILTIN);
      reg.clear();
      expect(reg.get("a")).toBeUndefined();
    });
  });

  describe("registerBuiltinVariables", () => {
    it("registers default variables", () => {
      const reg = new VariableRegistry();
      registerBuiltinVariables(reg, {
        agentName: "Helm",
        providerName: "deepseek",
        modelName: "deepseek-chat",
        toolCount: 5,
      });

      expect(reg.get("agent_name")).toBe("Helm");
      expect(reg.get("provider_name")).toBe("deepseek");
      expect(reg.get("model_name")).toBe("deepseek-chat");
      expect(reg.get("tool_count")).toBe("5");
      expect(reg.get("platform")).toBe(process.platform);
      expect(reg.get("shell")).toBeDefined();
      expect(reg.get("timestamp")).toBeDefined();
    });

    it("uses defaults when options are missing", () => {
      const reg = new VariableRegistry();
      registerBuiltinVariables(reg, {});
      expect(reg.get("agent_name")).toBe("Helm");
      expect(reg.get("provider_name")).toBe("unknown");
      expect(reg.get("tool_count")).toBe("0");
    });
  });

  describe("parseCliVariable", () => {
    it("parses key=value", () => {
      expect(parseCliVariable("project=helm")).toEqual(["project", "helm"]);
    });

    it("handles value with equals sign", () => {
      expect(parseCliVariable("url=http://x.com")).toEqual(["url", "http://x.com"]);
    });

    it("returns null for missing equals", () => {
      expect(parseCliVariable("noequals")).toBeNull();
    });

    it("returns null for empty key", () => {
      expect(parseCliVariable("=value")).toBeNull();
    });
  });
});

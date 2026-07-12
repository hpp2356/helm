// packages/prompt/src/template-engine.test.ts

import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  extractVariables,
  hashContent,
  tokenize,
} from "./template-engine.js";

describe("template-engine", () => {
  describe("tokenize", () => {
    it("splits text and template tokens", () => {
      const tokens = tokenize("Hello {{name}}, you are {{role}}.");
      expect(tokens).toEqual(["Hello ", "{{name}}", ", you are ", "{{role}}", "."]);
    });

    it("handles unclosed brace as text", () => {
      const tokens = tokenize("Hello {{name");
      expect(tokens).toEqual(["Hello ", "{{name"]);
    });

    it("handles no templates", () => {
      const tokens = tokenize("Just plain text.");
      expect(tokens).toEqual(["Just plain text."]);
    });
  });

  describe("renderTemplate", () => {
    it("substitutes simple variables", () => {
      const result = renderTemplate("Hello {{name}}!", { name: "World" });
      expect(result).toBe("Hello World!");
    });

    it("substitutes multiple variables", () => {
      const result = renderTemplate("I am {{agent}} on {{platform}}", {
        agent: "Helm",
        platform: "darwin",
      });
      expect(result).toBe("I am Helm on darwin");
    });

    it("omits undefined variables silently", () => {
      const result = renderTemplate("Hello {{name}} {{missing}}!", {});
      // Undefined variables render as empty, but surrounding whitespace remains
      expect(result).toBe("Hello  !");
    });

    it("handles conditional block with truthy variable", () => {
      const result = renderTemplate(
        "{{#if instructions}}\n{{instructions}}\n{{/if}}",
        { instructions: "Do something" },
      );
      expect(result).toContain("Do something");
    });

    it("handles conditional block with empty variable", () => {
      const result = renderTemplate(
        "Before{{#if instructions}}\n{{instructions}}\n{{/if}}After",
        { instructions: "" },
      );
      expect(result).toBe("BeforeAfter");
    });

    it("handles conditional block with missing variable", () => {
      const result = renderTemplate(
        "Before{{#if instructions}}\n{{instructions}}\n{{/if}}After",
        {},
      );
      expect(result).toBe("BeforeAfter");
    });

    it("handles conditional block with false value", () => {
      const result = renderTemplate(
        "{{#if show}}visible{{/if}}",
        { show: "false" },
      );
      expect(result).toBe("");
    });

    it("strips comments", () => {
      const result = renderTemplate("Hello {{! this is a comment }}World", {});
      expect(result).toBe("Hello World");
    });

    it("handles mixed content", () => {
      const template = `You are {{agent_name}}.
{{! Static section }}
Tools: {{tool_count}}
{{#if provider_instructions}}
Provider: {{provider_instructions}}
{{/if}}`;

      const result = renderTemplate(template, {
        agent_name: "Helm",
        tool_count: "5",
        provider_instructions: "Be concise",
      });

      expect(result).toContain("You are Helm.");
      expect(result).toContain("Tools: 5");
      expect(result).toContain("Provider: Be concise");
      expect(result).not.toContain("{{!");
    });

    it("handles conditional with no body content", () => {
      const result = renderTemplate("A{{#if x}}{{/if}}B", { x: "yes" });
      expect(result).toBe("AB");
    });
  });

  describe("extractVariables", () => {
    it("extracts simple variables", () => {
      const vars = extractVariables("Hello {{name}}, age {{age}}");
      expect(vars).toContain("name");
      expect(vars).toContain("age");
    });

    it("extracts conditional variable names", () => {
      const vars = extractVariables("{{#if show}}visible{{/if}}");
      expect(vars).toContain("show");
    });

    it("extracts variables from conditional body", () => {
      const vars = extractVariables("{{#if show}}{{content}}{{/if}}");
      expect(vars).toContain("show");
      expect(vars).toContain("content");
    });

    it("returns unique names", () => {
      const vars = extractVariables("{{name}} and {{name}}");
      expect(vars.filter((v) => v === "name")).toHaveLength(1);
    });
  });

  describe("hashContent", () => {
    it("returns consistent hash for same content", () => {
      const h1 = hashContent("hello world");
      const h2 = hashContent("hello world");
      expect(h1).toBe(h2);
    });

    it("returns different hash for different content", () => {
      const h1 = hashContent("hello");
      const h2 = hashContent("world");
      expect(h1).not.toBe(h2);
    });

    it("returns 8-char hex string", () => {
      const h = hashContent("test");
      expect(h).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});

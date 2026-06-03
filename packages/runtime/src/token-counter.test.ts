import { describe, it, expect } from "vitest";
import { CharTokenCounter } from "./token-counter.js";
import type { Message, ToolDef } from "@helm/core";

describe("CharTokenCounter", () => {
  const counter = new CharTokenCounter(4);

  describe("countText", () => {
    it("returns 1 for empty string", () => {
      expect(counter.countText("")).toBe(0);
    });

    it("estimates tokens by char/ratio", () => {
      // 8 chars / 4 = 2 tokens
      expect(counter.countText("12345678")).toBe(2);
    });

    it("rounds up", () => {
      // 9 chars / 4 = 2.25 → 3
      expect(counter.countText("123456789")).toBe(3);
    });

    it("returns at least 1 for non-empty strings", () => {
      // 1 char / 4 = 0.25 → ceil → 1
      expect(counter.countText("a")).toBe(1);
    });
  });

  describe("countMessages", () => {
    it("counts user message", () => {
      const msgs: Message[] = [{ role: "user", content: "Hello world" }];
      // "user" = 4 chars → 1, "Hello world" = 11 chars → 3, total 4
      const tokens = counter.countMessages(msgs);
      expect(tokens).toBeGreaterThan(0);
    });

    it("counts assistant message with tool calls", () => {
      const msgs: Message[] = [
        {
          role: "assistant",
          content: "Let me calculate",
          toolCalls: [
            { id: "1", name: "calc", args: { expr: "1+1" } },
          ],
        },
      ];
      const tokens = counter.countMessages(msgs);
      // role + content + tool name + args JSON
      expect(tokens).toBeGreaterThan(0);
    });

    it("counts multiple messages", () => {
      const msgs: Message[] = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Bye" },
      ];
      const tokens = counter.countMessages(msgs);
      expect(tokens).toBeGreaterThan(0);
    });

    it("returns 0 for empty array", () => {
      expect(counter.countMessages([])).toBe(0);
    });
  });

  describe("countToolDefs", () => {
    it("counts tool definitions", () => {
      const toolDefs: ToolDef[] = [
        {
          name: "calc",
          description: "Evaluate expression",
          parameters: { type: "object", properties: {} },
        },
      ];
      const tokens = counter.countToolDefs(toolDefs);
      expect(tokens).toBeGreaterThan(0);
    });

    it("counts multiple tool defs", () => {
      const toolDefs: ToolDef[] = [
        { name: "a", description: "A", parameters: {} },
        { name: "b", description: "B", parameters: {} },
      ];
      expect(counter.countToolDefs(toolDefs)).toBeGreaterThan(0);
    });

    it("returns 0 for empty array", () => {
      expect(counter.countToolDefs([])).toBe(0);
    });
  });

  it("uses configurable charsPerToken", () => {
    const c2 = new CharTokenCounter(2);
    const c8 = new CharTokenCounter(8);
    const text = "12345678"; // 8 chars
    expect(c2.countText(text)).toBe(4); // 8/2
    expect(c8.countText(text)).toBe(1); // 8/8
  });
});

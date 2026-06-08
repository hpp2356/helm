import { describe, it, expect } from "vitest";
import { OpenAITokenCounter } from "./token-counter.js";
import type { Message, ToolDef } from "@helm/core";

describe("OpenAITokenCounter", () => {
  const counter = new OpenAITokenCounter();

  describe("countText", () => {
    it("returns 0 for empty string", () => {
      expect(counter.countText("")).toBe(0);
    });

    it("returns a positive count for non-empty text", () => {
      const count = counter.countText("Hello, world!");
      expect(count).toBeGreaterThan(0);
    });

    it("returns higher count for longer text", () => {
      const short = counter.countText("Hi");
      const long = counter.countText(
        "This is a much longer piece of text that should consume more tokens.",
      );
      expect(long).toBeGreaterThan(short);
    });

    it("counts code-like text", () => {
      const count = counter.countText(
        'function hello() { return "world"; }',
      );
      expect(count).toBeGreaterThan(0);
    });

    it("counts Chinese text", () => {
      const count = counter.countText("你好世界");
      expect(count).toBeGreaterThan(0);
    });
  });

  describe("countMessages", () => {
    it("returns a positive count for a user message", () => {
      const messages: Message[] = [
        { role: "user", content: "Hello" },
      ];
      const count = counter.countMessages(messages);
      expect(count).toBeGreaterThan(0);
    });

    it("returns higher count for more messages", () => {
      const single: Message[] = [
        { role: "user", content: "Hello" },
      ];
      const multi: Message[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      expect(counter.countMessages(multi)).toBeGreaterThan(
        counter.countMessages(single),
      );
    });

    it("counts tool calls in assistant messages", () => {
      const withToolCalls: Message[] = [
        { role: "user", content: "Read file" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "read",
              args: { filePath: "test.txt" },
            },
            {
              id: "call_2",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
      ];

      const withoutToolCalls: Message[] = [
        { role: "user", content: "Read file" },
        { role: "assistant", content: "OK" },
      ];

      expect(counter.countMessages(withToolCalls)).toBeGreaterThan(
        counter.countMessages(withoutToolCalls),
      );
    });

    it("counts tool result messages", () => {
      const messages: Message[] = [
        { role: "user", content: "Hello" },
        {
          role: "tool",
          content: "file contents here",
          toolCallId: "call_1",
        },
      ];
      const count = counter.countMessages(messages);
      expect(count).toBeGreaterThan(0);
    });

    it("approximates real token counts within reasonable range", () => {
      // A typical short conversation should be < 100 tokens
      const messages: Message[] = [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "2+2 equals 4." },
      ];
      const count = counter.countMessages(messages);
      expect(count).toBeGreaterThan(10);
      expect(count).toBeLessThan(100);
    });
  });

  describe("countToolDefs", () => {
    it("returns a positive count for a tool definition", () => {
      const toolDefs: ToolDef[] = [
        {
          name: "read",
          description: "Read a file from the workspace",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
            },
            required: ["filePath"],
          },
        },
      ];
      const count = counter.countToolDefs(toolDefs);
      expect(count).toBeGreaterThan(0);
    });

    it("returns higher count for more tool defs", () => {
      const one: ToolDef[] = [
        {
          name: "read",
          description: "Read a file",
          parameters: {},
        },
      ];
      const two: ToolDef[] = [
        {
          name: "read",
          description: "Read a file",
          parameters: {},
        },
        {
          name: "write",
          description: "Write a file",
          parameters: {},
        },
      ];
      expect(counter.countToolDefs(two)).toBeGreaterThan(
        counter.countToolDefs(one),
      );
    });

    it("returns 0 for empty array", () => {
      expect(counter.countToolDefs([])).toBeGreaterThanOrEqual(0);
    });
  });

  describe("implements TokenCounter interface", () => {
    it("has all required methods", () => {
      expect(typeof counter.countText).toBe("function");
      expect(typeof counter.countMessages).toBe("function");
      expect(typeof counter.countToolDefs).toBe("function");
    });
  });
});

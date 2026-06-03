import { describe, it, expect } from "vitest";
import { ContextBuilder, toToolDefs } from "./context-builder.js";
import { CharTokenCounter } from "./token-counter.js";
import type { Message, ToolDef } from "@helm/core";

function makeCounter() {
  return new CharTokenCounter(4);
}

describe("ContextBuilder", () => {
  const counter = makeCounter();
  const builder = new ContextBuilder(counter);

  it("builds context from messages and tools", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
    ];
    const toolDefs: ToolDef[] = [
      { name: "calc", description: "Calculate", parameters: {} },
    ];

    const window = builder.build({ messages, toolDefs });

    expect(window.systemPrompt).toBeNull();
    expect(window.messages).toBe(messages);
    expect(window.toolDefs).toBe(toolDefs);
    expect(window.estimatedTokens).toBeGreaterThan(0);
  });

  it("includes system prompt in token estimate", () => {
    const windowNoSys = builder.build({
      messages: [{ role: "user", content: "Hi" }],
      toolDefs: [],
    });

    const windowWithSys = builder.build({
      systemPrompt: "You are a helpful assistant with detailed instructions",
      messages: [{ role: "user", content: "Hi" }],
      toolDefs: [],
    });

    expect(windowWithSys.estimatedTokens).toBeGreaterThan(
      windowNoSys.estimatedTokens,
    );
    expect(windowWithSys.systemPrompt).toBe(
      "You are a helpful assistant with detailed instructions",
    );
  });

  it("returns zero tokens for empty input", () => {
    const window = builder.build({
      messages: [],
      toolDefs: [],
    });

    expect(window.estimatedTokens).toBe(0);
    expect(window.messages).toEqual([]);
    expect(window.toolDefs).toEqual([]);
  });

  it("sets systemPrompt to null when not provided", () => {
    const window = builder.build({
      messages: [{ role: "user", content: "Hi" }],
      toolDefs: [],
    });

    expect(window.systemPrompt).toBeNull();
  });

  it("includes tool definitions in token estimate", () => {
    const windowNoTools = builder.build({
      messages: [{ role: "user", content: "Hi" }],
      toolDefs: [],
    });

    const windowWithTools = builder.build({
      messages: [{ role: "user", content: "Hi" }],
      toolDefs: [
        { name: "calc", description: "Calculate expression", parameters: { type: "object" } },
      ],
    });

    expect(windowWithTools.estimatedTokens).toBeGreaterThan(
      windowNoTools.estimatedTokens,
    );
  });
});

describe("toToolDefs", () => {
  it("extracts name, description, parameters from Tool", () => {
    const tool = {
      name: "calc",
      description: "Do math",
      parameters: { expr: "string" },
      execute: async () => "result",
    };

    const defs = toToolDefs([tool]);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("calc");
    expect(defs[0].description).toBe("Do math");
    expect(defs[0].parameters).toEqual({ expr: "string" });
    // @ts-expect-error — execute should not be present
    expect(defs[0].execute).toBeUndefined();
  });

  it("returns empty array for empty tools", () => {
    expect(toToolDefs([])).toEqual([]);
  });
});

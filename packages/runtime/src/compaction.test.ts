import { describe, it, expect } from "vitest";
import { Compaction, type CompactionOptions } from "./compaction.js";
import { CharTokenCounter } from "./token-counter.js";
import type { Message, Tool, ToolCall } from "@helm/core";
import { ScriptedProvider } from "./scripted-provider.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTools(): Tool[] {
  return [
    {
      name: "echo",
      description: "echoes input",
      parameters: {},
      execute: async () => "ok",
    },
    {
      name: "read",
      description: "reads files",
      parameters: {},
      execute: async () => "content",
    },
  ];
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

function asstMsg(content: string, toolCalls?: ToolCall[]): Message {
  return { role: "assistant", content, toolCalls } as Message;
}

function toolMsg(toolCallId: string, content: string): Message {
  return { role: "tool", content, toolCallId } as Message;
}

/** Build a multi-turn conversation with tool calls. */
function buildLongConversation(turnCount: number): Message[] {
  const messages: Message[] = [userMsg("Initial user request")];
  for (let i = 0; i < turnCount; i++) {
    messages.push(
      asstMsg(`Turn ${i} assistant`, [
        { id: `tc${i}`, name: "echo", args: { text: `hello${i}` } },
      ]),
    );
    messages.push(toolMsg(`tc${i}`, `echo: hello${i}`));
  }
  return messages;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Compaction.truncate", () => {
  const options: CompactionOptions = {
    strategy: "truncate",
    tokenCounter: new CharTokenCounter(),
    keepRecentTurns: 2,
  };

  it("does not compact when there are too few turns", async () => {
    const comp = new Compaction(options);
    // 1 user + 2 assistant+tool turns = 5 messages, but only 3 turns
    // Need: 1 (user) + 2 (keepRecent) + 1 (to compact) = 4 turns minimum
    const messages = buildLongConversation(2); // 3 turns total
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("compacts when there are enough turns", async () => {
    const comp = new Compaction(options);
    // 1 user + 5 assistant+tool turns = 11 messages, 6 turns
    const messages = buildLongConversation(5);
    expect(messages.length).toBe(11); // 1 user + 5*2 (asst+tool)
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(true);
    expect(result.messageCountBefore).toBe(11);
    // After: user (1) + truncation note (1) + 2 turns * 2 = 6
    expect(result.messageCountAfter).toBeLessThan(11);
    expect(result.tokensEstimatedAfter).toBeGreaterThan(0);
  });

  it("keeps the initial user message", async () => {
    const comp = new Compaction(options);
    const messages = buildLongConversation(5);
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(true);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toBe("Initial user request");
  });

  it("keeps the most recent turns uncompressed", async () => {
    const comp = new Compaction(options);
    const messages = buildLongConversation(5);
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(true);
    // Should end with the last 2 turns
    const lastMessages = result.messages.slice(-4); // 2 turns * 2 msgs each
    expect(lastMessages[0].role).toBe("assistant");
    expect(lastMessages[1].role).toBe("tool");
    expect(lastMessages[2].role).toBe("assistant");
    expect(lastMessages[3].role).toBe("tool");
  });

  it("inserts truncation note message", async () => {
    const comp = new Compaction(options);
    const messages = buildLongConversation(5);
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(true);
    // After user message, there should be a truncation note
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toContain("truncated");
  });

  it("preserves tool call/result pair integrity", async () => {
    const comp = new Compaction(options);
    // 1 user + 4 turns = 9 messages
    const messages = buildLongConversation(4);
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(true);
    // After compaction, the last message should be from turn 3 (the last turn)
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.content).toContain("echo: hello3");
    // The penultimate should be the assistant message for turn 3
    const penultimate = result.messages[result.messages.length - 2];
    expect(penultimate.role).toBe("assistant");
    expect(penultimate.content).toContain("Turn 3");
  });
});

describe("Compaction.summarize", () => {
  const summaryResponse = "This conversation involved echo operations testing turn logic.";

  function makeSummarizeOpts(providerResponses?: string[]): CompactionOptions {
    const responses = providerResponses ?? [summaryResponse];
    return {
      strategy: "summarize",
      provider: new ScriptedProvider(
        responses.map((r) => ({ role: "assistant", content: r })),
      ),
      tokenCounter: new CharTokenCounter(),
      keepRecentTurns: 2,
    };
  }

  it("summarizes middle turns via provider", async () => {
    const messages = buildLongConversation(5);
    const comp = new Compaction(makeSummarizeOpts());
    const result = await comp.compact(messages, makeTools());

    expect(result.didCompact).toBe(true);
    expect(result.summaryText).toBeDefined();
    expect(result.summaryText).toContain("conversation involved");
    expect(result.messageCountAfter).toBeLessThan(result.messageCountBefore);
  });

  it("includes summary as a user message", async () => {
    const messages = buildLongConversation(5);
    const comp = new Compaction(makeSummarizeOpts());
    const result = await comp.compact(messages, makeTools());

    // The summary should be a user message after the initial user message
    const summaryMsg = result.messages[1];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content).toContain("[Previous conversation summary]");
    expect(summaryMsg.content).toContain(summaryResponse);
  });

  it("falls back to truncation when provider fails", async () => {
    const messages = buildLongConversation(5);
    // Provider with error responses by using a provider that throws
    const brokenProvider = {
      send: async () => {
        throw new Error("provider failure");
      },
      setTools: () => {},
    };
    const comp = new Compaction({
      strategy: "summarize",
      provider: brokenProvider as CompactionOptions["provider"],
      tokenCounter: new CharTokenCounter(),
      keepRecentTurns: 2,
    });
    const result = await comp.compact(messages, makeTools());

    // Should still compact (truncation fallback)
    expect(result.didCompact).toBe(true);
    // No summary text from provider (fallback generates a placeholder)
    if (result.summaryText) {
      expect(result.summaryText).toContain("Compacted");
    }
  });

  it("does not compact when compaction would not reduce size", async () => {
    // Only 2 assistant+tool turns = too few to compress
    const messages = buildLongConversation(2);
    const comp = new Compaction(makeSummarizeOpts());
    const result = await comp.compact(messages, makeTools());
    expect(result.didCompact).toBe(false);
  });

  it("requires provider for summarize strategy", () => {
    expect(() => {
      new Compaction({
        strategy: "summarize",
        tokenCounter: new CharTokenCounter(),
      });
    }).toThrow("requires a provider");
  });
});

describe("Compaction with system prompt", () => {
  it("does not include system prompt in compacted messages", async () => {
    const options: CompactionOptions = {
      strategy: "truncate",
      tokenCounter: new CharTokenCounter(),
      systemPrompt: "You are a helpful assistant.",
      keepRecentTurns: 1,
    };
    const comp = new Compaction(options);
    const messages = buildLongConversation(4);
    const result = await comp.compact(messages, makeTools());

    // System prompt should NOT appear as a message
    for (const msg of result.messages) {
      expect(msg.content).not.toBe("You are a helpful assistant.");
    }
  });
});

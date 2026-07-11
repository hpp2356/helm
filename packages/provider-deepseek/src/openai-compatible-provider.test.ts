import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, ToolCall, StreamingEvent } from "@helm/core";
import { HelmError, StreamingBus } from "@helm/core";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import type { OpenAICompatibleProviderOptions } from "./openai-compatible-provider.js";

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a mock SSE stream chunk for text content. */
function textChunk(content: string, finishReason?: string) {
  return {
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

/** Create a mock SSE stream chunk for tool call delta. */
function toolCallChunk(
  index: number,
  partial: {
    id?: string;
    name?: string;
    arguments?: string;
  },
) {
  const fn: Record<string, string> = {};
  if (partial.name !== undefined) fn.name = partial.name;
  if (partial.arguments !== undefined) fn.arguments = partial.arguments;

  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(partial.id ? { id: partial.id } : {}),
              function: fn,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Create a final chunk with finish_reason. */
function finalChunk(finishReason: string) {
  return {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

/** Build an async generator from an array of chunks (simulates an SSE stream). */
async function* mockStream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

interface MockCreateArgs {
  stream: boolean;
  signal?: AbortSignal;
  model?: string;
  messages?: unknown[];
  tools?: unknown[];
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

/** Create a mock OpenAI client that returns a controlled stream. */
function createMockClient(
  chunks: unknown[],
  opts?: { throwOnCreate?: Error },
) {
  const createMock = vi
    .fn()
    .mockImplementation(async (_params: MockCreateArgs) => {
      if (opts?.throwOnCreate) {
        throw opts.throwOnCreate;
      }
      return mockStream(chunks);
    });

  return {
    chat: {
      completions: {
        create: createMock,
      },
    },
  };
}

function makeProvider(
  overrides?: Partial<OpenAICompatibleProviderOptions>,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    ...overrides,
  });
}

/** Narrow a Message to the assistant variant for testing. */
function asAssistant(msg: Message): {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
} {
  if (msg.role !== "assistant") {
    throw new Error(`Expected assistant message but got ${msg.role}`);
  }
  return msg;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("OpenAICompatibleProvider", () => {
  // ── Message conversion ─────────────────────────────────────────────────

  describe("message conversion (Helm → OpenAI)", () => {
    it("converts a UserMessage to OpenAI user role", async () => {
      const mockClient = createMockClient([
        textChunk("Hello!", "stop"),
      ]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream([textChunk("Hello!", "stop")]),
      );

      // We test message conversion indirectly by checking what was sent
      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const messages: Message[] = [{ role: "user", content: "Hi" }];
      await provider.send(messages);

      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.messages).toEqual([{ role: "user", content: "Hi" }]);
    });

    it("converts an AssistantMessage to OpenAI assistant role", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const messages: Message[] = [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ];
      await provider.send(messages);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.messages).toHaveLength(2);
      expect(callArg.messages?.[0]).toEqual({
        role: "user",
        content: "question",
      });
      expect(callArg.messages?.[1]).toEqual({
        role: "assistant",
        content: "answer",
      });
    });

    it("converts an AssistantMessage with tool calls to OpenAI format", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const messages: Message[] = [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "Let me check",
          toolCalls: [
            {
              id: "call_123",
              name: "read",
              args: { filePath: "test.txt" },
            },
          ],
        },
      ];
      await provider.send(messages);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      const assistantMsg = callArg.messages?.[1] as Record<string, unknown>;
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toBe("Let me check");
      expect(assistantMsg.tool_calls).toEqual([
        {
          id: "call_123",
          type: "function",
          function: {
            name: "read",
            arguments: '{"filePath":"test.txt"}',
          },
        },
      ]);
    });

    it("converts a ToolResult to OpenAI tool role with tool_call_id", async () => {
      const mockClient = createMockClient([
        textChunk("Got it", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const messages: Message[] = [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_123",
              name: "read",
              args: { filePath: "test.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: "file contents here",
          toolCallId: "call_123",
        },
      ];
      await provider.send(messages);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      const toolMsg = callArg.messages?.[2] as Record<string, unknown>;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toBe("file contents here");
      expect(toolMsg.tool_call_id).toBe("call_123");
    });
  });

  // ── Response parsing ──────────────────────────────────────────────────

  describe("response parsing (OpenAI stream → Helm Message)", () => {
    it("returns AssistantMessage from text-only response", async () => {
      const chunks = [
        textChunk("Hello"),
        textChunk(" world!"),
        finalChunk("stop"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "Hi" },
      ]);

      const assistant = asAssistant(result);
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toBe("Hello world!");
      expect(assistant.toolCalls).toBeUndefined();
    });

    it("returns AssistantMessage with tool calls", async () => {
      const chunks = [
        textChunk("Let me check that."),
        toolCallChunk(0, {
          id: "call_abc",
          name: "read",
          arguments: '{"filePath":"test.txt"}',
        }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "Read test.txt" },
      ]);

      const assistant1 = asAssistant(result);
      expect(assistant1.role).toBe("assistant");
      expect(assistant1.content).toBe("Let me check that.");
      expect(assistant1.toolCalls).toHaveLength(1);
      expect(assistant1.toolCalls?.[0]).toMatchObject({
        id: "call_abc",
        name: "read",
        args: { filePath: "test.txt" },
      });
    });

    it("handles streaming tool calls across multiple chunks", async () => {
      // Simulate OpenAI streaming tool calls in multiple chunks
      const chunks = [
        toolCallChunk(0, {
          id: "call_xyz",
          name: "bash",
        }),
        toolCallChunk(0, {
          arguments: '{"comman',
        }),
        toolCallChunk(0, {
          arguments: 'd":"ls -la"}',
        }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "List files" },
      ]);

      const assistant2 = asAssistant(result);
      expect(assistant2.toolCalls).toHaveLength(1);
      expect(assistant2.toolCalls?.[0]).toMatchObject({
        id: "call_xyz",
        name: "bash",
        args: { command: "ls -la" },
      });
    });

    it("handles multiple tool calls in one response", async () => {
      const chunks = [
        toolCallChunk(0, {
          id: "call_1",
          name: "read",
          arguments: '{"filePath":"a.txt"}',
        }),
        toolCallChunk(1, {
          id: "call_2",
          name: "read",
          arguments: '{"filePath":"b.txt"}',
        }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "Read two files" },
      ]);

      const assistant3 = asAssistant(result);
      expect(assistant3.toolCalls).toHaveLength(2);
      expect(assistant3.toolCalls?.[0].id).toBe("call_1");
      expect(assistant3.toolCalls?.[0].name).toBe("read");
      expect(assistant3.toolCalls?.[1].id).toBe("call_2");
      expect(assistant3.toolCalls?.[1].name).toBe("read");
    });

    it("returns empty content when response has only tool calls", async () => {
      const chunks = [
        toolCallChunk(0, {
          id: "call_abc",
          name: "bash",
          arguments: '{"command":"ls"}',
        }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "List files" },
      ]);

      const assistant4 = asAssistant(result);
      expect(assistant4.content).toBe("");
      expect(assistant4.toolCalls).toBeDefined();
    });
  });

  // ── Tool definition conversion ────────────────────────────────────────

  describe("tool definition conversion", () => {
    it("sends tools in OpenAI format when set", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      provider.setTools([
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
            },
            required: ["filePath"],
          },
        },
      ]);

      await provider.send([{ role: "user", content: "Hi" }]);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.tools).toEqual([
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                filePath: { type: "string" },
              },
              required: ["filePath"],
            },
          },
        },
      ]);
    });

    it("does not send tools when none are set", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Hi" }]);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.tools).toBeUndefined();
    });
  });

  // ── Error mapping ─────────────────────────────────────────────────────

  describe("error mapping", () => {
    it("maps 401 to auth_failure (non-retryable)", async () => {
      const authError = Object.assign(new Error("Invalid API key"), {
        status: 401,
        name: "AuthenticationError",
      });

      const mockClient = createMockClient([], {
        throwOnCreate: authError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await expect(
        provider.send([{ role: "user", content: "Hi" }]),
      ).rejects.toThrow(HelmError);

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.type).toBe("provider");
        expect(helmErr.agentError.category).toBe("auth_failure");
        expect(helmErr.agentError.retryable).toBe(false);
        if (helmErr.agentError.type === "provider") {
          expect(helmErr.agentError.statusCode).toBe(401);
        }
      }
    });

    it("maps 403 to auth_failure (non-retryable)", async () => {
      const permError = Object.assign(new Error("Forbidden"), {
        status: 403,
      });

      const mockClient = createMockClient([], {
        throwOnCreate: permError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("auth_failure");
        expect(helmErr.agentError.retryable).toBe(false);
      }
    });

    it("maps 429 to rate_limit (retryable)", async () => {
      const rateError = Object.assign(new Error("Too many requests"), {
        status: 429,
      });

      const mockClient = createMockClient([], {
        throwOnCreate: rateError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("rate_limit");
        expect(helmErr.agentError.retryable).toBe(true);
        if (helmErr.agentError.type === "provider") {
          expect(helmErr.agentError.statusCode).toBe(429);
        }
      }
    });

    it("maps 500 to server_error (retryable)", async () => {
      const serverError = Object.assign(new Error("Internal error"), {
        status: 500,
      });

      const mockClient = createMockClient([], {
        throwOnCreate: serverError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("server_error");
        expect(helmErr.agentError.retryable).toBe(true);
        if (helmErr.agentError.type === "provider") {
          expect(helmErr.agentError.statusCode).toBe(500);
        }
      }
    });

    it("maps 502/503 to server_error (retryable)", async () => {
      const serverError = Object.assign(new Error("Bad gateway"), {
        status: 502,
      });

      const mockClient = createMockClient([], {
        throwOnCreate: serverError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("server_error");
        expect(helmErr.agentError.retryable).toBe(true);
      }
    });

    it("maps APIConnectionError to network (retryable)", async () => {
      const connError = Object.assign(new Error("Connection refused"), {
        name: "APIConnectionError",
      });

      const mockClient = createMockClient([], {
        throwOnCreate: connError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("network");
        expect(helmErr.agentError.retryable).toBe(true);
      }
    });

    it("maps api_connection_error type to network (retryable)", async () => {
      const connError = Object.assign(new Error("Connection failed"), {
        type: "api_connection_error",
      });

      const mockClient = createMockClient([], {
        throwOnCreate: connError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("network");
        expect(helmErr.agentError.retryable).toBe(true);
      }
    });

    it("maps APITimeoutError to timeout (retryable)", async () => {
      const timeoutError = Object.assign(new Error("Request timed out"), {
        name: "APITimeoutError",
      });

      const mockClient = createMockClient([], {
        throwOnCreate: timeoutError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("timeout");
        expect(helmErr.agentError.retryable).toBe(true);
      }
    });

    it("maps unknown errors to unknown (non-retryable)", async () => {
      const unknownError = new Error("Something weird happened");

      const mockClient = createMockClient([], {
        throwOnCreate: unknownError,
      });

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      try {
        await provider.send([{ role: "user", content: "Hi" }]);
        expect.fail("Should have thrown");
      } catch (err) {
        const helmErr = err as HelmError;
        expect(helmErr.agentError.category).toBe("unknown");
        expect(helmErr.agentError.retryable).toBe(false);
      }
    });
  });

  // ── Interface compliance ──────────────────────────────────────────────

  describe("Provider interface", () => {
    it("implements the Provider interface (returns correct shape)", async () => {
      const mockClient = createMockClient([
        textChunk("Hello!", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      const result = await provider.send([
        { role: "user", content: "Hi" },
      ]);

      expect(result).toHaveProperty("role", "assistant");
      expect(typeof result.content).toBe("string");
    });

    it("accepts optional AbortSignal parameter", async () => {
      const controller = new AbortController();
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = makeProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send(
        [{ role: "user", content: "Hi" }],
        controller.signal,
      );

      // Signal should have been passed through
      const callArg = mockClient.chat.completions.create.mock
        .calls[0][1] as { signal?: AbortSignal };
      expect(callArg?.signal).toBe(controller.signal);
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────

  describe("cancellation", () => {
    it("throws AbortError when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = makeProvider();

      await expect(
        provider.send(
          [{ role: "user", content: "Hi" }],
          controller.signal,
        ),
      ).rejects.toThrow("The operation was aborted");
    });
  });

  // ── Configuration defaults ────────────────────────────────────────────

  describe("configuration defaults", () => {
    it("uses DeepSeek defaults", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = new OpenAICompatibleProvider({ apiKey: "key" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Hi" }]);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.model).toBe("deepseek-v4-flash");
      expect(callArg.max_tokens).toBe(4096);
      expect(callArg.temperature).toBe(0.7);
    });

    it("allows custom configuration", async () => {
      const mockClient = createMockClient([
        textChunk("OK", "stop"),
      ]);

      const provider = new OpenAICompatibleProvider({
        apiKey: "key",
        model: "deepseek-v4-pro",
        baseURL: "https://custom.api.com",
        maxTokens: 8000,
        temperature: 0.3,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Hi" }]);

      const callArg = mockClient.chat.completions.create.mock
        .calls[0][0] as MockCreateArgs;
      expect(callArg.model).toBe("deepseek-v4-pro");
      expect(callArg.max_tokens).toBe(8000);
      expect(callArg.temperature).toBe(0.3);
    });
  });

  // ── Tools setTools / getter/setter ────────────────────────────────────

  describe("setTools", () => {
    it("preserves tool definitions via setTools", () => {
      const provider = makeProvider();

      const toolDefs = [
        {
          name: "bash",
          description: "Execute bash",
          parameters: { type: "object", properties: {} },
        },
      ];

      provider.setTools(toolDefs);
      expect(provider.tools).toEqual(toolDefs);
    });

    it("allows clearing tools via setter", () => {
      const provider = makeProvider();
      provider.setTools([
        { name: "bash", description: "d", parameters: {} },
      ]);
      provider.tools = undefined;
      expect(provider.tools).toBeUndefined();
    });
  });

  // ── StreamingBus integration ──────────────────────────────────────────

  describe("StreamingBus integration", () => {
    it("emits text_delta events to the bus", async () => {
      const chunks = [
        textChunk("Hello"),
        textChunk(" world!"),
        finalChunk("stop"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const bus = new StreamingBus();
      const received: StreamingEvent[] = [];
      bus.on((e) => received.push(e));

      const provider = makeProvider({ streamingBus: bus });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Hi" }]);

      const textDeltas = received.filter((e) => e.type === "text_delta");
      expect(textDeltas).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world!" },
      ]);
    });

    it("emits tool_call_delta events to the bus", async () => {
      const chunks = [
        toolCallChunk(0, { id: "call_1", name: "read" }),
        toolCallChunk(0, { arguments: '{"filePath":"test.txt"}' }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const bus = new StreamingBus();
      const received: StreamingEvent[] = [];
      bus.on((e) => received.push(e));

      const provider = makeProvider({ streamingBus: bus });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Read file" }]);

      const toolDeltas = received.filter(
        (e) => e.type === "tool_call_delta",
      );
      expect(toolDeltas.length).toBeGreaterThanOrEqual(2);
      expect(toolDeltas[0]).toMatchObject({
        type: "tool_call_delta",
        id: "call_1",
        name: "read",
      });
    });

    it("emits thinking_delta for reasoning_content", async () => {
      // Create chunks with reasoning_content (DeepSeek-specific)
      const thinkingChunk = {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "Let me think..." },
            finish_reason: null,
          },
        ],
      };
      const answerChunk = textChunk("The answer is 42.");
      const chunks = [thinkingChunk, answerChunk, finalChunk("stop")];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const bus = new StreamingBus();
      const received: StreamingEvent[] = [];
      bus.on((e) => received.push(e));

      const provider = makeProvider({ streamingBus: bus });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "Think" }]);

      const thinkingDeltas = received.filter(
        (e) => e.type === "thinking_delta",
      );
      expect(thinkingDeltas).toEqual([
        { type: "thinking_delta", text: "Let me think..." },
      ]);
    });

    it("setStreamingBus replaces the bus", async () => {
      const chunks = [textChunk("Hi"), finalChunk("stop")];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const bus1 = new StreamingBus();
      const bus2 = new StreamingBus();
      const received1: StreamingEvent[] = [];
      const received2: StreamingEvent[] = [];
      bus1.on((e) => received1.push(e));
      bus2.on((e) => received2.push(e));

      const provider = makeProvider({ streamingBus: bus1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      provider.setStreamingBus(bus2);
      await provider.send([{ role: "user", content: "Hi" }]);

      // bus1 should NOT receive events (replaced before send)
      expect(received1.filter((e) => e.type === "text_delta")).toHaveLength(0);
      // bus2 SHOULD receive events
      expect(received2.filter((e) => e.type === "text_delta")).toHaveLength(1);
    });

    it("works without a bus (backward compatible)", async () => {
      const chunks = [textChunk("OK"), finalChunk("stop")];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const provider = makeProvider(); // no bus
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      // Should not throw
      const result = await provider.send([
        { role: "user", content: "Hi" },
      ]);
      expect(asAssistant(result).content).toBe("OK");
    });

    it("stats accumulate correctly through the bus", async () => {
      const chunks = [
        textChunk("Hello"),
        textChunk(" world"),
        toolCallChunk(0, { id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }),
        finalChunk("tool_calls"),
      ];

      const mockClient = createMockClient([]);
      vi.mocked(mockClient.chat.completions.create).mockResolvedValueOnce(
        mockStream(chunks),
      );

      const bus = new StreamingBus();
      const provider = makeProvider({ streamingBus: bus });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client = mockClient;

      await provider.send([{ role: "user", content: "List files" }]);

      expect(bus.stats.textTokens).toBe(11); // "Hello" + " world"
      expect(bus.stats.textDeltaCount).toBe(2);
      expect(bus.stats.toolCallDeltaCount).toBeGreaterThanOrEqual(1);
    });
  });
});

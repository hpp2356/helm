import type { Message, Provider, ToolCall } from "@helm/core";
import { HelmError, providerError } from "@helm/core";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ── Configuration ──────────────────────────────────────────────────────────

export interface OpenAICompatibleProviderOptions {
  /** API key (caller responsibility — read from env). */
  apiKey: string;
  /** Model name. Default: "deepseek-v4-flash" (cheaper for testing). */
  model?: string;
  /** Base URL for the OpenAI-compatible endpoint. Default: DeepSeek. */
  baseURL?: string;
  /** Max tokens for the completion. Default: 4096. */
  maxTokens?: number;
  /** Sampling temperature. Default: 0.7. */
  temperature?: number;
}

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

// ── Streaming accumulator ──────────────────────────────────────────────────

interface AccumulatingToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
}

interface StreamAccumulator {
  content: string;
  toolCalls: Map<number, AccumulatingToolCall>;
  finishReason: string | null;
}

function createAccumulator(): StreamAccumulator {
  return {
    content: "",
    toolCalls: new Map(),
    finishReason: null,
  };
}

function assembleToolCalls(
  acc: StreamAccumulator,
): ToolCall[] | undefined {
  if (acc.toolCalls.size === 0) return undefined;

  const calls: ToolCall[] = [];
  for (const tc of acc.toolCalls.values()) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.arguments);
    } catch {
      // If JSON parse fails, keep args as empty object —
      // this should not happen with well-formed API responses
    }
    calls.push({
      id: tc.id,
      name: tc.name,
      args,
    });
  }
  return calls.length > 0 ? calls : undefined;
}

// ── Message conversion: Helm → OpenAI ─────────────────────────────────────

function helmToOpenAIMessages(
  messages: Message[],
): ChatCompletionMessageParam[] {
  const openaiMessages: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        openaiMessages.push({ role: "user", content: msg.content });
        break;

      case "assistant": {
        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          (assistantMsg as unknown as Record<string, unknown>).tool_calls =
            msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args),
              },
            }));
        }
        openaiMessages.push(assistantMsg);
        break;
      }

      case "tool":
        openaiMessages.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
        break;

      // Forward-compat: handle future roles (system, etc.)
      default: {
        const unknownMsg = msg as unknown as { role: string; content: string };
        openaiMessages.push({
          role: unknownMsg.role as "system",
          content: unknownMsg.content,
        } as ChatCompletionMessageParam);
        break;
      }
    }
  }

  return openaiMessages;
}

// ── Tool definition conversion: Helm → OpenAI ─────────────────────────────

interface HelmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function helmToOpenAITools(
  tools?: HelmToolDef[],
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
}

// ── Error mapping: OpenAI SDK errors → HelmError ──────────────────────────

function classifyOpenAIError(err: unknown): HelmError {
  // Check for OpenAI SDK error types
  if (typeof err === "object" && err !== null) {
    const apiErr = err as Record<string, unknown>;

    // OpenAI SDK uses status codes on errors
    const status = apiErr.status as number | undefined;

    if (status === 401 || status === 403) {
      return providerError(
        "auth_failure",
        `Authentication failed (${status}): ${getErrorMessage(err)}`,
        status,
      );
    }
    if (status === 429) {
      return providerError(
        "rate_limit",
        `Rate limited (429): ${getErrorMessage(err)}`,
        429,
      );
    }
    if (status && status >= 500) {
      return providerError(
        "server_error",
        `Server error (${status}): ${getErrorMessage(err)}`,
        status,
      );
    }

    // Check for connection/network errors by type/name
    const errType = (apiErr.type as string) || "";
    const errName = (apiErr.name as string) || "";

    if (
      errType === "api_connection_error" ||
      errName === "APIConnectionError" ||
      errName === "ConnectionError"
    ) {
      return providerError(
        "network",
        `Network error: ${getErrorMessage(err)}`,
      );
    }

    if (
      errType === "api_timeout_error" ||
      errName === "APITimeoutError" ||
      errName === "TimeoutError"
    ) {
      return providerError(
        "timeout",
        `Request timeout: ${getErrorMessage(err)}`,
      );
    }
  }

  // Unknown
  return providerError(
    "unknown",
    `Unexpected error: ${getErrorMessage(err)}`,
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}

// ── Provider ───────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  /** Optional: tools to include in every request (set by AgentLoop). */
  private _tools?: HelmToolDef[];

  constructor(options: OpenAICompatibleProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    });
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  }

  /** Set tools from the Provider interface (called by AgentLoop). */
  setTools(tools: HelmToolDef[]): void {
    this._tools = tools;
  }

  /** @deprecated Use setTools() instead — kept for backward compat. */
  set tools(tools: HelmToolDef[] | undefined) {
    this._tools = tools;
  }

  get tools(): HelmToolDef[] | undefined {
    return this._tools;
  }

  async send(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<Message> {
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    const openaiMessages = helmToOpenAIMessages(messages);
    const openaiTools = helmToOpenAITools(this._tools);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: openaiMessages,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
          tools: openaiTools,
          stream: true,
        },
        {
          signal,
        },
      );

      const acc = createAccumulator();

      for await (const chunk of stream) {
        // Check for abort mid-stream
        if (signal?.aborted) {
          // Stop consuming — controller will throw, caught below
          break;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Accumulate text
        if (delta.content) {
          acc.content += delta.content;
        }

        // Accumulate tool calls (streamed incrementally by index)
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            const existing = acc.toolCalls.get(idx) ?? {
              id: "",
              index: idx,
              name: "",
              arguments: "",
            };

            if (tcDelta.id) existing.id = tcDelta.id;
            if (tcDelta.function?.name) {
              existing.name += tcDelta.function.name;
            }
            if (tcDelta.function?.arguments) {
              existing.arguments += tcDelta.function.arguments;
            }

            acc.toolCalls.set(idx, existing);
          }
        }

        // Capture finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          acc.finishReason = chunk.choices[0].finish_reason;
        }
      }

      // If aborted mid-stream, throw AbortError
      if (signal?.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }

      // Max tokens reached — the content might be truncated
      // We still return what we have; decisions about retry are up to the caller
      if (acc.finishReason === "length") {
        // Truncation: return what we have, content may be incomplete.
        // This is not an error — the model delivered what it could within
        // the token limit. The caller can decide whether to continue.
      }

      const toolCalls = assembleToolCalls(acc);

      return {
        role: "assistant",
        content: acc.content,
        ...(toolCalls ? { toolCalls } : {}),
      };
    } catch (err) {
      // Re-throw AbortError so AgentLoop routes it to cancellation
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }

      // Map to classified HelmError
      throw classifyOpenAIError(err);
    }
  }
}

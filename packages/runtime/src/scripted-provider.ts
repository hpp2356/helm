import {
  type Message,
  type Provider,
  type ProviderError,
  HelmError,
} from "@helm/core";

// ── Error injection ──────────────────────────────────────────────────────
//
// ScriptedProvider can inject errors so tests can exercise retry paths
// without a real flaky network. Instead of a Message, put a
// ScriptedErrorEntry in the constructor array:
//
//   {
//     _error: true,
//     message: "rate limit exceeded",
//     category: "rate_limit",
//     statusCode: 429,
//   }
//
// When ScriptedProvider reaches this entry, it throws a HelmError with
// the matching AgentError payload. The index advances past the error
// entry so the next send() call gets the following response.
//
// To simulate multiple consecutive failures (retry exhaustion), stack
// multiple error entries before the first success:
//
//   const provider = new ScriptedProvider([
//     { _error: true, message: "fail 1", category: "server_error" },
//     { _error: true, message: "fail 2", category: "server_error" },
//     { role: "assistant", content: "succeeded on attempt 3" },
//   ]);

export interface ScriptedErrorEntry {
  _error: true;
  message: string;
  category?: ProviderError["category"];
  statusCode?: number;
}

export type ScriptedResponse = Message | ScriptedErrorEntry;

function isErrorEntry(
  entry: ScriptedResponse,
): entry is ScriptedErrorEntry {
  return "_error" in entry && (entry as ScriptedErrorEntry)._error === true;
}

function makeAbortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The operation was aborted",
  );
  err.name = "AbortError";
  return err;
}

const PROVIDER_RETRYABLE: Record<string, boolean> = {
  rate_limit: true,
  server_error: true,
  network: true,
  timeout: true,
  auth_failure: false,
  unknown: false,
};

function toHelmError(entry: ScriptedErrorEntry): HelmError {
  const category = entry.category ?? "unknown";
  return new HelmError({
    type: "provider",
    category,
    message: entry.message,
    retryable: PROVIDER_RETRYABLE[category] ?? false,
    statusCode: entry.statusCode,
  });
}

export class ScriptedProvider implements Provider {
  private responses: ScriptedResponse[];
  private index = 0;

  constructor(responses: ScriptedResponse[]) {
    this.responses = responses;
  }

  async send(
    _messages: Message[],
    signal?: AbortSignal,
  ): Promise<Message> {
    if (signal?.aborted) {
      throw makeAbortError(signal.reason);
    }
    if (this.index >= this.responses.length) {
      throw new Error(
        `ScriptedProvider exhausted: no response at index ${this.index}`,
      );
    }
    const entry = this.responses[this.index++];
    if (isErrorEntry(entry)) {
      throw toHelmError(entry);
    }
    return entry;
  }
}

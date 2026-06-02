import { type Message, type Provider } from "@helm/core";

function makeAbortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The operation was aborted"
  );
  err.name = "AbortError";
  return err;
}

export class ScriptedProvider implements Provider {
  private responses: Message[];
  private index = 0;

  constructor(responses: Message[]) {
    this.responses = responses;
  }

  async send(_messages: Message[], signal?: AbortSignal): Promise<Message> {
    if (signal?.aborted) {
      throw makeAbortError(signal.reason);
    }
    if (this.index >= this.responses.length) {
      throw new Error(
        `ScriptedProvider exhausted: no response at index ${this.index}`
      );
    }
    return this.responses[this.index++];
  }
}

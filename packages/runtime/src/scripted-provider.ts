import { type Message, type Provider } from "@helm/core";

export class ScriptedProvider implements Provider {
  private responses: Message[];
  private index = 0;

  constructor(responses: Message[]) {
    this.responses = responses;
  }

  async send(_messages: Message[]): Promise<Message> {
    if (this.index >= this.responses.length) {
      throw new Error(
        `ScriptedProvider exhausted: no response at index ${this.index}`
      );
    }
    return this.responses[this.index++];
  }
}

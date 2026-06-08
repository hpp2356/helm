export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Provider {
  send(messages: Message[], signal?: AbortSignal): Promise<Message>;
  /**
   * Optional: set tool definitions available for the next send() call.
   * Called by AgentLoop before each turn. Providers that don't need tools
   * (e.g. ScriptedProvider) can leave this unimplemented.
   */
  setTools?(tools: { name: string; description: string; parameters: Record<string, unknown> }[]): void;
}

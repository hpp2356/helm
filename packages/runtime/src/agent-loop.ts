import { type Provider, type Tool, type JsonlJournal } from "@helm/core";

export interface AgentLoopOptions {
  maxTurns: number;
}

export class AgentLoop {
  constructor(
    private provider: Provider,
    private tools: Map<string, Tool>,
    private journal: JsonlJournal,
    private options: AgentLoopOptions = { maxTurns: 10 }
  ) {}

  async run(runId: string, userMessage: string): Promise<void> {
    const messages: Array<{
      role: string;
      content: string;
      toolCalls?: unknown;
      toolCallId?: string;
    }> = [{ role: "user", content: userMessage }];

    await this.journal.append({
      type: "run:start",
      runId,
      timestamp: Date.now(),
    });

    for (let turnIndex = 0; turnIndex < this.options.maxTurns; turnIndex++) {
      await this.journal.append({
        type: "turn:start",
        runId,
        turnIndex,
        timestamp: Date.now(),
      });

      let response: Awaited<ReturnType<Provider["send"]>>;
      try {
        response = await this.provider.send(
          messages as Parameters<Provider["send"]>[0]
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        await this.journal.append({
          type: "error",
          runId,
          message,
          timestamp: Date.now(),
        });
        break;
      }

      messages.push(response);

      if (
        response.role === "assistant" &&
        response.toolCalls &&
        response.toolCalls.length > 0
      ) {
        for (const tc of response.toolCalls) {
          await this.journal.append({
            type: "tool:call",
            runId,
            turnIndex,
            toolName: tc.name,
            args: tc.args,
            timestamp: Date.now(),
          });

          const tool = this.tools.get(tc.name);
          let output: string;
          if (tool) {
            try {
              output = await tool.execute(tc.args);
            } catch (err) {
              output = `Error: ${
                err instanceof Error ? err.message : String(err)
              }`;
            }
          } else {
            output = `Error: unknown tool "${tc.name}"`;
          }

          await this.journal.append({
            type: "tool:result",
            runId,
            turnIndex,
            toolName: tc.name,
            output,
            timestamp: Date.now(),
          });

          messages.push({
            role: "tool",
            content: output,
            toolCallId: tc.id,
          });
        }
      } else {
        // No tool calls — assistant gave final answer, end the loop
        break;
      }
    }

    await this.journal.append({
      type: "run:end",
      runId,
      timestamp: Date.now(),
      exitCode: 0,
    });
  }
}

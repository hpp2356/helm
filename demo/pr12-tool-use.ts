// PR12 Demo: Tool use complete cycle (needs DEEPSEEK_API_KEY)
import { OpenAICompatibleProvider } from "../packages/provider-deepseek/dist/index.js";
import { getApiKey } from "./api-key.js";

const provider = new OpenAICompatibleProvider({ apiKey: getApiKey() });

// Register tools (simulates what AgentLoop does via setTools)
provider.setTools([
  {
    name: "calculator",
    description: "Evaluate a mathematical expression. Returns the computed result.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression, e.g. \"2 + 3 * 4\"" }
      },
      required: ["expression"]
    }
  }
]);

console.log("=== Tool Use 完整循环 ===");

// Turn 1: user asks → model returns tool call
console.log("--- Turn 1 ---");
const messages = [
  { role: "user" as const, content: "What is 123 * 456?" }
];

const turn1 = await provider.send(messages);
console.log("Role:", turn1.role);
console.log("Content:", turn1.content || "(empty — model chose tool)");
if (turn1.toolCalls) {
  for (const tc of turn1.toolCalls) {
    console.log("Tool Call:", tc.name, JSON.stringify(tc.args));
  }
}

// Turn 2: send tool result → model returns final answer
if (turn1.toolCalls) {
  console.log("");
  console.log("--- Turn 2 ---");
  messages.push(turn1);

  for (const tc of turn1.toolCalls) {
    messages.push({
      role: "tool",
      content: String(123 * 456),
      toolCallId: tc.id
    });
  }

  const turn2 = await provider.send(messages);
  console.log("Role:", turn2.role);
  console.log("Content:", turn2.content);
  console.log("ToolCalls:", turn2.toolCalls ?? "none");
}

// PR12 Demo: First real LLM conversation (needs DEEPSEEK_API_KEY)
import { OpenAICompatibleProvider } from "../packages/provider-deepseek/dist/index.js";
import { getApiKey } from "./api-key.js";

const provider = new OpenAICompatibleProvider({ apiKey: getApiKey() });

console.log("=== 第一次真实 LLM 对话 ===");
const response = await provider.send([
  { role: "user", content: "Hello! What is 2+2?" }
]);

console.log("Role:", response.role);
console.log("Content:", response.content);
console.log("ToolCalls:", response.toolCalls ?? "none");

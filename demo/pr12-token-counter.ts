// PR12 Demo: Token Counter comparison (no API key needed)
import { CharTokenCounter } from "../packages/runtime/dist/index.js";
import { OpenAITokenCounter } from "../packages/provider-deepseek/dist/index.js";

const char = new CharTokenCounter();
const real = new OpenAITokenCounter();

const texts = [
  "Hello, world!",
  "function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }",
  "你好世界",
  'console.log("hello");',
];

console.log("=== Token Counter Comparison ===");
console.log("Text                          | Char(4) | cl100k_base | Diff");
console.log("-".repeat(75));

for (const t of texts) {
  const cc = char.countText(t);
  const rc = real.countText(t);
  const label = t.length > 30 ? t.slice(0, 27) + "..." : t.padEnd(30);
  const diff = cc !== rc ? (rc > cc ? "+" + (rc - cc) : String(rc - cc)) : "=";
  console.log(label + "| " + String(cc).padStart(7) + " | " + String(rc).padStart(11) + " | " + diff);
}

console.log("");
console.log("=== Message Token Count ===");
const messages = [
  { role: "user" as const, content: "What is the capital of France?" },
  { role: "assistant" as const, content: "The capital of France is Paris." },
];
console.log("Conversation (2 messages):");
console.log("  CharTokenCounter:   " + char.countMessages(messages));
console.log("  OpenAITokenCounter: " + real.countMessages(messages));

console.log("");
console.log("=== 中文 Token 计数差异 ===");
const cnMsg = "你好世界，这是一个测试。";
console.log("Text: " + cnMsg);
console.log("  Char(4):       " + char.countText(cnMsg) + " (中文每字约 1-2 token)");
console.log("  cl100k_base:   " + real.countText(cnMsg) + " (实际 token)");

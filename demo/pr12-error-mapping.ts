// PR12 Demo: Error mapping + retry (needs DEEPSEEK_API_KEY)
import { OpenAICompatibleProvider } from "../packages/provider-deepseek/dist/index.js";
import { HelmError } from "../packages/core/dist/index.js";
import { getApiKey } from "./api-key.js";

// Use a bad API key to trigger auth_failure
console.log("=== Error Mapping: Auth Failure ===");
const badProvider = new OpenAICompatibleProvider({ apiKey: "sk-invalid-key" });

try {
  await badProvider.send([{ role: "user", content: "Hi" }]);
  console.log("ERROR: Should have thrown");
} catch (err) {
  if (err instanceof HelmError) {
    const ae = err.agentError;
    console.log("Type:", ae.type);
    console.log("Category:", ae.category);
    console.log("Retryable:", ae.retryable);
    if (ae.type === "provider") {
      console.log("StatusCode:", ae.statusCode);
    }
    console.log("Message:", ae.message);
  } else {
    console.log("Raw error:", err);
  }
}

// Use valid key for normal call
console.log("");
console.log("=== Normal Call with Valid Key ===");
const provider = new OpenAICompatibleProvider({ apiKey: getApiKey() });

try {
  const response = await provider.send([{ role: "user", content: "Say hello in one word." }]);
  console.log("Role:", response.role);
  console.log("Content:", response.content);
  console.log("(No error — auth works)");
} catch (err) {
  console.log("Error:", err);
}

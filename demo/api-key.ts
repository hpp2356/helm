// Shared helper: read DeepSeek API key from file or env.
// Priority: DEEPSEEK_API_KEY env > ~/.deepseek-api-key file
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getApiKey(): string {
  // 1. env var (highest priority — CI, container)
  if (process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }

  // 2. key file (~/.deepseek-api-key)
  try {
    const keyPath = join(homedir(), ".deepseek-api-key");
    const key = readFileSync(keyPath, "utf-8").trim();
    if (key) return key;
  } catch {
    // file doesn't exist — fall through
  }

  throw new Error(
    "No DeepSeek API key found.\n" +
    "  Option 1: echo 'sk-...' > ~/.deepseek-api-key\n" +
    "  Option 2: export DEEPSEEK_API_KEY='sk-...'"
  );
}

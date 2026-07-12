// packages/memory/src/auto-memory.ts
import type { AutoMemoryTrigger, AutoMemoryWrite } from "./types.js";

/** Detect auto-memory triggers from conversation context. */
export function detectAutoMemoryTriggers(
  userMessage: string,
  assistantMessage: string,
): AutoMemoryTrigger | null {
  const lower = userMessage.toLowerCase();

  // Correction: user corrects the agent
  if (
    lower.includes("不要") ||
    lower.includes("不对") ||
    lower.includes("错了") ||
    lower.includes("wrong") ||
    lower.includes("don't") ||
    lower.includes("actually") ||
    lower.includes("纠正") ||
    lower.includes("correction")
  ) {
    return "correction";
  }

  // Discovery: agent discovers something new
  if (
    lower.includes("记住") ||
    lower.includes("remember") ||
    lower.includes("note that") ||
    lower.includes("keep in mind")
  ) {
    return "discovery";
  }

  // Preference: user expresses a preference
  if (
    lower.includes("我喜欢") ||
    lower.includes("我偏好") ||
    lower.includes("i prefer") ||
    lower.includes("i like") ||
    lower.includes("always") ||
    lower.includes("从不") ||
    lower.includes("never")
  ) {
    return "preference";
  }

  return null;
}

/** Create an auto-memory write from a trigger. */
export function createAutoMemoryWrite(
  trigger: AutoMemoryTrigger,
  content: string,
  context?: string,
): AutoMemoryWrite {
  return { trigger, content, context };
}

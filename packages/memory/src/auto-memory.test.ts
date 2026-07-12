import { describe, it, expect } from "vitest";
import { detectAutoMemoryTriggers, createAutoMemoryWrite } from "./auto-memory.js";

describe("detectAutoMemoryTriggers", () => {
  it("detects correction trigger", () => {
    expect(detectAutoMemoryTriggers("不要这样写", "")).toBe("correction");
    expect(detectAutoMemoryTriggers("不对，应该是...", "")).toBe("correction");
    expect(detectAutoMemoryTriggers("That's wrong", "")).toBe("correction");
  });

  it("detects discovery trigger", () => {
    expect(detectAutoMemoryTriggers("记住这个命令", "")).toBe("discovery");
    expect(detectAutoMemoryTriggers("Remember this pattern", "")).toBe("discovery");
  });

  it("detects preference trigger", () => {
    expect(detectAutoMemoryTriggers("我喜欢用中文回复", "")).toBe("preference");
    expect(detectAutoMemoryTriggers("I prefer dark mode", "")).toBe("preference");
  });

  it("returns null for neutral messages", () => {
    expect(detectAutoMemoryTriggers("hello", "")).toBeNull();
    expect(detectAutoMemoryTriggers("what is the weather?", "")).toBeNull();
  });
});

describe("createAutoMemoryWrite", () => {
  it("creates a write object", () => {
    const write = createAutoMemoryWrite("discovery", "vitest needs typecheck", "during testing");
    expect(write.trigger).toBe("discovery");
    expect(write.content).toBe("vitest needs typecheck");
    expect(write.context).toBe("during testing");
  });

  it("works without context", () => {
    const write = createAutoMemoryWrite("correction", "use interface not type");
    expect(write.context).toBeUndefined();
  });
});

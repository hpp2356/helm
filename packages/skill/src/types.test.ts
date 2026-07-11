import { describe, it, expect } from "vitest";
import { parseSkillInput } from "./types.js";

describe("parseSkillInput", () => {
  it("parses /help", () => {
    const result = parseSkillInput("/help");
    expect(result).toEqual({ name: "help", input: "" });
  });

  it("parses /search helm mcp", () => {
    const result = parseSkillInput("/search helm mcp");
    expect(result).toEqual({ name: "search", input: "helm mcp" });
  });

  it("parses /code-review", () => {
    const result = parseSkillInput("/code-review");
    expect(result).toEqual({ name: "code-review", input: "" });
  });

  it("parses /my-skill some args here", () => {
    const result = parseSkillInput("/my-skill some args here");
    expect(result).toEqual({ name: "my-skill", input: "some args here" });
  });

  it("handles input without leading slash", () => {
    const result = parseSkillInput("help");
    expect(result).toEqual({ name: "help", input: "" });
  });

  it("lowercases the skill name", () => {
    const result = parseSkillInput("/Help");
    expect(result).toEqual({ name: "help", input: "" });
  });

  it("handles extra whitespace", () => {
    const result = parseSkillInput("  /search   helm mcp  ");
    expect(result).toEqual({ name: "search", input: "helm mcp" });
  });

  it("handles empty input after name", () => {
    const result = parseSkillInput("/search  ");
    expect(result).toEqual({ name: "search", input: "" });
  });
});

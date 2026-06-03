import { describe, it, expect } from "vitest";
import {
  HelmError,
  classifyAgentError,
  providerError,
  type AgentError,
  type ProviderError,
  type ToolError,
  type HarnessError,
} from "./errors.js";

describe("AgentError taxonomy", () => {
  it("HelmError wraps a provider AgentError", () => {
    const ae: ProviderError = {
      type: "provider",
      category: "rate_limit",
      message: "too many requests",
      retryable: true,
      statusCode: 429,
    };
    const err = new HelmError(ae);
    expect(err.name).toBe("HelmError");
    expect(err.agentError).toBe(ae);
    expect(err.message).toBe("too many requests");
  });

  it("HelmError wraps a tool AgentError", () => {
    const ae: ToolError = {
      type: "tool",
      category: "tool_error",
      message: "division by zero",
      retryable: false,
      toolName: "calculator",
    };
    const err = new HelmError(ae);
    expect(err.agentError.type).toBe("tool");
    expect(err.agentError.retryable).toBe(false);
  });

  it("HelmError wraps a harness AgentError", () => {
    const ae: HarnessError = {
      type: "harness",
      category: "journal_write_failure",
      message: "disk full",
      retryable: false,
    };
    const err = new HelmError(ae);
    expect(err.agentError.type).toBe("harness");
  });
});

describe("classifyAgentError", () => {
  it("returns structured payload from HelmError", () => {
    const err = new HelmError({
      type: "provider",
      category: "network",
      message: "connection refused",
      retryable: true,
    });
    const result = classifyAgentError(err);
    expect(result.type).toBe("provider");
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies AbortError as harness/internal", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const result = classifyAgentError(err);
    expect(result.type).toBe("harness");
    expect(result.category).toBe("internal");
    expect(result.retryable).toBe(false);
  });

  it("classifies unknown Error as provider/unknown", () => {
    const err = new Error("something broke");
    const result = classifyAgentError(err);
    expect(result.type).toBe("provider");
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
  });

  it("classifies non-Error throw as provider/unknown", () => {
    const result = classifyAgentError("just a string");
    expect(result.type).toBe("provider");
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("just a string");
    expect(result.retryable).toBe(false);
  });
});

describe("providerError helper", () => {
  it("sets retryable=true for rate_limit", () => {
    const err = providerError("rate_limit", "slow down", 429);
    const ae = err.agentError;
    expect(ae.retryable).toBe(true);
    expect(ae.type).toBe("provider");
    if (ae.type === "provider") {
      expect(ae.statusCode).toBe(429);
    }
  });

  it("sets retryable=true for server_error", () => {
    const err = providerError("server_error", "internal", 500);
    expect(err.agentError.retryable).toBe(true);
  });

  it("sets retryable=true for network", () => {
    const err = providerError("network", "ECONNREFUSED");
    expect(err.agentError.retryable).toBe(true);
  });

  it("sets retryable=true for timeout", () => {
    const err = providerError("timeout", "timed out");
    expect(err.agentError.retryable).toBe(true);
  });

  it("sets retryable=false for auth_failure", () => {
    const err = providerError("auth_failure", "invalid key", 401);
    expect(err.agentError.retryable).toBe(false);
  });

  it("sets retryable=false for unknown", () => {
    const err = providerError("unknown", "???");
    expect(err.agentError.retryable).toBe(false);
  });
});

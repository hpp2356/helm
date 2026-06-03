/**
 * Error taxonomy for the Helm harness.
 *
 * Every error that occurs during an agent run is classified into one of three
 * top-level types: provider, tool, or harness. Each variant carries a
 * `retryable` flag so the retry layer doesn't need its own classification
 * logic.
 *
 * Usage:
 *   const ae = classifyAgentError(thrownError);
 *   if (ae.retryable) { ... retry ... }
 */

export type AgentError = ProviderError | ToolError | HarnessError;

export interface ProviderError {
  type: "provider";
  category:
    | "rate_limit"
    | "server_error"
    | "auth_failure"
    | "network"
    | "timeout"
    | "unknown";
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export interface ToolError {
  type: "tool";
  category: "tool_error" | "tool_not_found" | "tool_timeout";
  message: string;
  retryable: boolean;
  toolName?: string;
}

export interface HarnessError {
  type: "harness";
  category: "invalid_state" | "journal_write_failure" | "internal";
  message: string;
  retryable: boolean;
}

const PROVIDER_RETRYABLE: Record<ProviderError["category"], boolean> = {
  rate_limit: true,
  server_error: true,
  network: true,
  timeout: true,
  auth_failure: false,
  unknown: false,
};

/** Error subclass that carries a structured AgentError payload. */
export class HelmError extends Error {
  readonly agentError: AgentError;
  constructor(error: AgentError) {
    super(error.message);
    this.name = "HelmError";
    this.agentError = error;
  }
}

function isHelmError(err: unknown): err is HelmError {
  return err instanceof Error && err.name === "HelmError";
}

/**
 * Classify any thrown value into the AgentError taxonomy.
 * Provider.send / Tool.execute throwers should throw HelmError so their
 * structured payload flows through directly; unknown throws are classified
 * as provider/unknown.
 */
export function classifyAgentError(err: unknown): AgentError {
  if (isHelmError(err)) {
    return err.agentError;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      type: "harness",
      category: "internal",
      message: err.message,
      retryable: false,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: "provider",
    category: "unknown",
    message,
    retryable: false,
  };
}

/** Create a HelmError for a provider-level failure. */
export function providerError(
  category: ProviderError["category"],
  message: string,
  statusCode?: number,
): HelmError {
  return new HelmError({
    type: "provider",
    category,
    message,
    retryable: PROVIDER_RETRYABLE[category],
    statusCode,
  });
}

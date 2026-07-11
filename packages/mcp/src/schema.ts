// packages/mcp/src/schema.ts
import type { Tool } from "@helm/core";
import type { McpToolDef } from "./types.js";
import type { McpClient } from "./client.js";

/**
 * Convert an MCP tool definition + backing client into a Helm Tool.
 *
 * The returned tool's execute function delegates to `client.callTool`,
 * serialising the structured content blocks back to a single JSON string
 * that the agent can consume.
 */
export function mcpToolToHelmTool(
  mcpTool: McpToolDef,
  client: McpClient,
  riskLevel: Tool["riskLevel"] = undefined,
): Tool {
  // Build Helm-compatible parameters schema.
  // MCP inputSchema is already JSON Schema — we pass it through.
  const parameters: Record<string, unknown> = {
    type: mcpTool.inputSchema.type,
  };
  if (mcpTool.inputSchema.properties) {
    parameters.properties = mcpTool.inputSchema.properties;
  }
  if (mcpTool.inputSchema.required) {
    parameters.required = mcpTool.inputSchema.required;
  }

  return {
    name: mcpTool.name,
    description: mcpTool.description ?? mcpTool.name,
    parameters,
    riskLevel,
    async execute(args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool(mcpTool.name, args);

      // Serialise content blocks back to a string.
      if (result.isError) {
        // Prepend "Error:" so Helm's tool result parsing treats it as
        // a failure (matching existing convention in ToolRuntime/file-tools).
        return (
          "Error: " +
          result.content
            .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
            .join("\n")
        );
      }

      return result.content
        .map((c) => {
          switch (c.type) {
            case "text":
              return c.text;
            case "image":
              return `[image: ${c.mimeType}, ${c.data.length} bytes]`;
            case "resource":
              return c.resource.text ?? c.resource.blob ?? c.resource.uri;
            default:
              return JSON.stringify(c);
          }
        })
        .join("\n");
    },
  };
}

/**
 * Schema type names used by MCP servers.
 * Subset of JSON Schema types that Helm's provider can meaningfully
 * describe in a function definition.
 */
const SUPPORTED_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

/**
 * Normalise an MCP inputSchema so its properties only use type names
 * the LLM provider can handle (string/number/integer/boolean/object/array).
 * Unknown types (null, etc.) are mapped to "string".
 */
export function normaliseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = { ...schema };

  if (typeof out.type === "string" && !SUPPORTED_TYPES.has(out.type as string)) {
    out.type = "string";
  }

  if (out.properties && typeof out.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      out.properties as Record<string, unknown>,
    )) {
      props[k] = normaliseSchema(v as Record<string, unknown>);
    }
    out.properties = props;
  }

  if (out.items && typeof out.items === "object") {
    out.items = normaliseSchema(out.items as Record<string, unknown>);
  }

  return out;
}

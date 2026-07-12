// packages/prompt/src/template-engine.ts

/**
 * Simple template engine for prompt templates.
 *
 * Syntax:
 *   {{variable}}         — variable substitution
 *   {{#if var}}...{{/if}} — conditional block
 *   {{! comment }}       — comment (stripped from output)
 *
 * No loops, no nesting of conditionals (keep it simple).
 */

/** Parsed template node types. */
type TemplateNode =
  | { type: "text"; value: string }
  | { type: "variable"; name: string }
  | { type: "conditional"; name: string; body: TemplateNode[] }
  | { type: "comment"; value: string };

/** Tokenize template string into raw tokens. */
function tokenize(template: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < template.length) {
    const openIdx = template.indexOf("{{", i);
    if (openIdx === -1) {
      tokens.push(template.slice(i));
      break;
    }
    if (openIdx > i) {
      tokens.push(template.slice(i, openIdx));
    }
    const closeIdx = template.indexOf("}}", openIdx + 2);
    if (closeIdx === -1) {
      // Unclosed brace — treat rest as text
      tokens.push(template.slice(openIdx));
      break;
    }
    tokens.push(template.slice(openIdx, closeIdx + 2));
    i = closeIdx + 2;
  }
  return tokens;
}

/** Parse tokens into AST nodes. */
function parse(tokens: string[]): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (!token.startsWith("{{")) {
      nodes.push({ type: "text", value: token });
      i++;
      continue;
    }

    // Extract inner content between {{ and }}
    const inner = token.slice(2, -2).trim();

    if (inner.startsWith("!")) {
      // Comment — skip
      nodes.push({ type: "comment", value: inner.slice(1).trim() });
      i++;
      continue;
    }

    if (inner.startsWith("#if ")) {
      // Conditional block — find matching {{/if}}
      const varName = inner.slice(4).trim();
      const bodyTokens: string[] = [];
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        const t = tokens[i]!;
        if (t.startsWith("{{")) {
          const innerT = t.slice(2, -2).trim();
          if (innerT === "#if " + varName || innerT.startsWith("#if ")) {
            depth++;
          } else if (innerT === "/if") {
            depth--;
            if (depth === 0) {
              i++;
              continue;
            }
          }
        }
        bodyTokens.push(t);
        i++;
      }
      nodes.push({
        type: "conditional",
        name: varName,
        body: parse(bodyTokens),
      });
      continue;
    }

    if (inner === "/if") {
      // Stray {{/if}} — skip
      i++;
      continue;
    }

    // Variable substitution
    nodes.push({ type: "variable", name: inner });
    i++;
  }

  return nodes;
}

/** Render AST nodes with variable values. */
function render(nodes: TemplateNode[], vars: Record<string, string>): string {
  const parts: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parts.push(node.value);
        break;
      case "comment":
        // Comments are stripped
        break;
      case "variable": {
        const val = vars[node.name];
        if (val !== undefined) {
          parts.push(val);
        }
        // If undefined, render empty string (silent omission)
        break;
      }
      case "conditional": {
        const val = vars[node.name];
        if (val !== undefined && val !== "" && val !== "false") {
          parts.push(render(node.body, vars));
        }
        break;
      }
    }
  }

  return parts.join("");
}

/**
 * Render a template string with the given variables.
 *
 * @param template — template string with {{var}}, {{#if}}, {{!}} syntax
 * @param variables — key-value pairs for substitution
 * @returns rendered string
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  const tokens = tokenize(template);
  const nodes = parse(tokens);
  return render(nodes, variables);
}

/**
 * Extract all variable names referenced in a template.
 * Useful for cache key computation (know which dynamic vars are used).
 */
export function extractVariables(template: string): string[] {
  const tokens = tokenize(template);
  const nodes = parse(tokens);
  const vars = new Set<string>();

  function walk(nodes: TemplateNode[]): void {
    for (const node of nodes) {
      if (node.type === "variable") {
        vars.add(node.name);
      } else if (node.type === "conditional") {
        vars.add(node.name);
        walk(node.body);
      }
    }
  }

  walk(nodes);
  return [...vars];
}

/**
 * Compute a simple hash of a string for cache key generation.
 * Uses FNV-1a-like hash for speed, returns hex string.
 */
export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Re-export for testing
export { tokenize, parse, render };

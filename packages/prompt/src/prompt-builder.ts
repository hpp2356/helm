// packages/prompt/src/prompt-builder.ts

import { renderTemplate, extractVariables, hashContent } from "./template-engine.js";
import { PromptLoader, type PromptLoaderOptions } from "./prompt-loader.js";
import {
  VariableRegistry,
  registerBuiltinVariables,
  loadVariablesFromFile,
} from "./variable-registry.js";
import { DEFAULT_TEMPLATE, CONCISE_TEMPLATE } from "./default-prompt.js";
import {
  VariableSource,
  type BuiltPrompt,
  type PromptLayers,
  type PromptBuildOptions,
} from "./types.js";

/**
 * Fluent prompt builder.
 *
 * Usage:
 *   const prompt = await PromptBuilder.create()
 *     .loadTemplate('deepseek.tpl')
 *     .setVariables({ agent_name: 'helm' })
 *     .applyOutputStyle('concise')
 *     .append('Always respond in Chinese')
 *     .build();
 */
export class PromptBuilder {
  private loader: PromptLoader;
  private registry: VariableRegistry;
  private templateName = "default";
  private templateContent: string | null = null;
  private outputStyleBody: string | null = null;
  private outputStyleKeepCoding = true;
  private appendString: string | null = null;
  private systemPromptOverride: string | null | undefined = undefined;
  // undefined = use template, null = no system prompt, string = custom

  private constructor(loaderOptions: PromptLoaderOptions = {}) {
    this.loader = new PromptLoader(loaderOptions);
    this.registry = new VariableRegistry();
  }

  /**
   * Create a new PromptBuilder instance.
   */
  static create(loaderOptions: PromptLoaderOptions = {}): PromptBuilder {
    return new PromptBuilder(loaderOptions);
  }

  /**
   * Load a template by name (file-based with provider fallback).
   * If not found externally, uses built-in default.
   */
  useTemplate(name: string): this {
    this.templateName = name;
    this.templateContent = this.loader.loadTemplate(name);
    return this;
  }

  /**
   * Set the provider name for per-provider template resolution.
   */
  withProvider(providerName: string): this {
    // Re-try loading with provider name
    const providerTemplate = this.loader.loadTemplate(providerName);
    if (providerTemplate) {
      this.templateContent = providerTemplate;
      this.templateName = providerName;
    }
    return this;
  }

  /**
   * Register builtin variables (agent_name, timestamp, etc.).
   */
  registerBuiltins(options: PromptBuildOptions): this {
    registerBuiltinVariables(this.registry, {
      agentName: options.agentName,
      providerName: options.providerName,
      modelName: options.modelName,
      toolCount: options.toolCount,
    });

    // Dynamic variables
    if (options.mcpInstructions) {
      this.registry.set("mcp_instructions", options.mcpInstructions, VariableSource.BUILTIN);
    }
    if (options.providerInstructions) {
      this.registry.set("provider_instructions", options.providerInstructions, VariableSource.BUILTIN);
    }

    return this;
  }

  /**
   * Load variables from vars.json files (global and project-level).
   */
  loadVarsFiles(): this {
    // Global-level
    const globalVars = this.loader.loadVarsFile();
    if (globalVars) {
      for (const [key, value] of Object.entries(globalVars)) {
        this.registry.set(key, value, VariableSource.GLOBAL_FILE);
      }
    }
    return this;
  }

  /**
   * Set variables from CLI --prompt-var flags.
   */
  setVariables(vars: Record<string, string>, source = VariableSource.CLI_FLAG): this {
    for (const [key, value] of Object.entries(vars)) {
      this.registry.set(key, value, source);
    }
    return this;
  }

  /**
   * Set a direct system prompt override (--system-prompt flag).
   * undefined = use template, null = no system prompt, string = custom text.
   */
  setSystemPromptOverride(prompt: string | null | undefined): this {
    this.systemPromptOverride = prompt;
    return this;
  }

  /**
   * Apply an output style (appended to prompt, not replacing).
   */
  applyOutputStyle(styleName: string): this {
    const style = this.loader.loadOutputStyle(styleName);
    if (style) {
      this.outputStyleBody = style.body;
      this.outputStyleKeepCoding = style.keepCodingInstructions;
    }
    return this;
  }

  /**
   * Append a user string to the prompt (--append-prompt flag).
   */
  append(text: string): this {
    this.appendString = text;
    return this;
  }

  /**
   * Build the final prompt.
   *
   * Progressive loading:
   *   - static: template without dynamic variables (cacheable)
   *   - dynamic: dynamic variable values (timestamp, provider_instructions)
   *   - append: output style + user append
   */
  build(): BuiltPrompt {
    // null = explicitly no system prompt
    if (this.systemPromptOverride === null) {
      return {
        content: "",
        layers: { static: "", dynamic: "", append: "" },
        cacheKey: hashContent(""),
        templateName: "override",
      };
    }

    // string = direct override, bypass template
    if (this.systemPromptOverride !== undefined) {
      const content = this.systemPromptOverride;
      return {
        content,
        layers: { static: content, dynamic: "", append: "" },
        cacheKey: hashContent(content),
        templateName: "override",
      };
    }

    // Get template (external file or built-in)
    const template = this.templateContent ?? DEFAULT_TEMPLATE;

    // Separate static and dynamic variables
    const templateVars = extractVariables(template);
    const dynamicVarNames = new Set([
      "timestamp",
      "provider_instructions",
      "mcp_instructions",
    ]);

    const allVars = this.registry.toRecord();

    // Build static layer (template with only static vars resolved)
    const staticVars: Record<string, string> = {};
    const dynamicVars: Record<string, string> = {};

    for (const [key, value] of Object.entries(allVars)) {
      if (dynamicVarNames.has(key)) {
        dynamicVars[key] = value;
      } else {
        staticVars[key] = value;
      }
    }

    // Render with only static vars → static layer
    // For dynamic vars, use placeholder to preserve structure
    const staticPlaceholders: Record<string, string> = { ...staticVars };
    for (const name of dynamicVarNames) {
      if (!staticPlaceholders[name]) {
        staticPlaceholders[name] = `{{${name}}}`;
      }
    }
    const staticLayer = renderTemplate(template, staticPlaceholders);

    // Render with all vars → static + dynamic
    const fullRender = renderTemplate(template, allVars);

    // Build append layer
    const appendParts: string[] = [];
    if (this.outputStyleBody) {
      appendParts.push(this.outputStyleBody);
    }
    if (this.appendString) {
      appendParts.push(this.appendString);
    }
    const appendLayer = appendParts.join("\n\n");

    // Dynamic layer = difference between full render and static layer
    const dynamicLayer = dynamicVars.timestamp || dynamicVars.provider_instructions || dynamicVars.mcp_instructions
      ? Object.entries(dynamicVars)
          .filter(([_, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "";

    // Compose final content
    const content = [fullRender, appendLayer].filter(Boolean).join("\n\n");

    return {
      content,
      layers: {
        static: staticLayer,
        dynamic: dynamicLayer,
        append: appendLayer,
      },
      cacheKey: hashContent(staticLayer),
      templateName: this.templateName,
    };
  }
}

/**
 * Quick helper: build a prompt with sensible defaults.
 */
export function buildDefaultPrompt(options: PromptBuildOptions & {
  appendPrompt?: string;
  outputStyle?: string;
  systemPromptOverride?: string | null;
} = {}): BuiltPrompt {
  const builder = PromptBuilder.create()
    .registerBuiltins(options);

  if ("systemPromptOverride" in options) {
    builder.setSystemPromptOverride(options.systemPromptOverride);
  }

  if (options.outputStyle) {
    builder.applyOutputStyle(options.outputStyle);
  }

  if (options.appendPrompt) {
    builder.append(options.appendPrompt);
  }

  return builder.build();
}

// packages/skill/src/registry.ts
import type { JsonlJournal } from "@helm/core";
import type { Skill, SkillContext } from "./types.js";

/** Options for SkillRegistry. */
export interface SkillRegistryOptions {
  /** Journal for emitting skill events. */
  journal?: JsonlJournal;
  /** Run ID for journal events. */
  runId?: string;
}

/**
 * Central registry for all skills.
 *
 * Skills are registered from multiple sources (built-in, plugins, user files).
 * Lookup is by name (case-insensitive, without leading slash).
 * First registration wins on name conflicts.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private journal?: JsonlJournal;
  private runId: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.journal = options.journal;
    this.runId = options.runId ?? "skill";
  }

  /** Register a skill. Silently skips if name already taken. */
  register(skill: Skill): void {
    const key = skill.name.toLowerCase();
    if (this.skills.has(key)) return; // first wins
    this.skills.set(key, skill);
  }

  /** Look up a skill by name (case-insensitive, without leading slash). */
  get(name: string): Skill | undefined {
    return this.skills.get(name.toLowerCase());
  }

  /** Check if a skill exists. */
  has(name: string): boolean {
    return this.skills.has(name.toLowerCase());
  }

  /** List all registered skills. */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** Execute a skill by name. Returns the handler's text output. */
  async execute(name: string, input: string, ctx: SkillContext): Promise<string> {
    const skill = this.get(name);
    if (!skill) {
      return `Unknown skill: /${name}. Type /help for available skills.`;
    }

    // Emit skill:call event
    await this.emitCall(name, input);

    try {
      const result = await skill.handler(input, ctx);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.emitError(name, errorMsg);
      return `Error in /${name}: ${errorMsg}`;
    }
  }

  /** Number of registered skills. */
  get count(): number {
    return this.skills.size;
  }

  private async emitCall(name: string, input: string): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.append({
        type: "skill:call",
        runId: this.runId,
        skillName: name,
        input,
        timestamp: Date.now(),
      });
    } catch { /* best-effort */ }
  }

  private async emitError(name: string, message: string): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.append({
        type: "skill:error",
        runId: this.runId,
        skillName: name,
        message,
        timestamp: Date.now(),
      });
    } catch { /* best-effort */ }
  }
}

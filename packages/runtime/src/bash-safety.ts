import * as path from "node:path";
import type { WorkspaceGuard } from "./workspace-guard.js";

// ── Dangerous patterns ──────────────────────────────────────────────────────

interface DangerPattern {
  pattern: RegExp;
  description: string;
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  { pattern: /\brm\s+.*(-[a-z]*r|--recursive)/i, description: "recursive delete (rm -rf)" },
  { pattern: /\bsudo\b/i, description: "privilege escalation (sudo)" },
  { pattern: /\bchmod\s+[0-7]*7/i, description: "world-writable permissions" },
  { pattern: /\b(curl|wget)\s+.*\|\s*(ba)?sh\b/i, description: "pipe to shell" },
  { pattern: /[>|]\s*\/dev\/(sd|hd|nvme|md|dm|loop)/i, description: "write to block device" },
  { pattern: /\bmkfs\b/i, description: "filesystem creation (mkfs)" },
  { pattern: /\bdd\s+if=/i, description: "disk operation (dd)" },
  { pattern: /:\s*\(\s*\)\s*\{/, description: "fork bomb pattern" },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i, description: "system shutdown/reboot" },
  { pattern: /\b(systemctl|sysctl)\b/i, description: "system control" },
  { pattern: /\b(kill|killall|pkill)\b/i, description: "process killing" },
  { pattern: /\bchown\b/i, description: "file ownership change" },
  { pattern: /\bchgrp\b/i, description: "group ownership change" },
  { pattern: /\b(iptables|nftables|ufw)\b/i, description: "firewall modification" },
  { pattern: /\b(mount|umount)\b/i, description: "filesystem mount/unmount" },
];

// ── Allowed commands ────────────────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set([
  // File/text operations
  "ls", "cat", "head", "tail", "grep", "find", "wc", "sort", "uniq",
  "echo", "date", "which", "mkdir", "cp", "mv", "touch", "rm",
  "sleep",
  // Dev tools
  "node", "npm", "pnpm", "git", "tsc", "vitest", "npx",
]);

// ── Path extraction ─────────────────────────────────────────────────────────

const SUSPICIOUS_PATH_RE = /(?:^|\s)(\/\S+|~\/\S+|\S*\.\.\/\S*)/g;

// ── Command extraction ──────────────────────────────────────────────────────

/** Extract base command names from a potentially compound command string. */
function extractBaseCommands(command: string): string[] {
  const segments = command.split(/\||&&|\|\||;/);
  const commands: string[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    // Skip env var assignments (FOO=bar, KEY=value)
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0 && !w.includes("="));
    if (words.length > 0) {
      const base = path.basename(words[0]);
      commands.push(base);
    }
  }

  return commands;
}

// ── Result type ─────────────────────────────────────────────────────────────

export interface BashSafetyResult {
  safe: boolean;
  reason?: string;
  warnings?: string[];
}

// ── BashSafety ──────────────────────────────────────────────────────────────

export class BashSafety {
  constructor(private guard: WorkspaceGuard) {}

  check(command: string): BashSafetyResult {
    const warnings: string[] = [];

    // 1. Check dangerous patterns against the full command string
    for (const { pattern, description } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          safe: false,
          reason: `command contains dangerous pattern: ${description}`,
          warnings,
        };
      }
    }

    // 2. Extract and validate suspicious file paths
    let match;
    SUSPICIOUS_PATH_RE.lastIndex = 0;
    while ((match = SUSPICIOUS_PATH_RE.exec(command)) !== null) {
      const suspectPath = match[1].trim();
      try {
        this.guard.validate(suspectPath);
      } catch {
        return {
          safe: false,
          reason: `command references path outside workspace: "${suspectPath}"`,
          warnings,
        };
      }
    }

    // 3. Extract base commands and check against allowlist
    const baseCommands = extractBaseCommands(command);
    if (baseCommands.length === 0) {
      return {
        safe: false,
        reason: "could not determine the command to execute",
        warnings,
      };
    }

    for (const cmd of baseCommands) {
      if (!ALLOWED_COMMANDS.has(cmd)) {
        // Check if it's one of our "always allow" patterns — but if not, default deny
        return {
          safe: false,
          reason: `command "${cmd}" is not in the allowlist. Unknown commands are denied by default.`,
          warnings,
        };
      }
    }

    // 4. Warn about shell features for awareness
    if (command.includes("|")) {
      warnings.push("command uses pipes");
    }
    if (command.includes("&&") || command.includes("||")) {
      warnings.push("command chains multiple sub-commands");
    }
    if (command.includes(">") || command.includes(">>")) {
      warnings.push("command redirects output to a file");
    }

    return {
      safe: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

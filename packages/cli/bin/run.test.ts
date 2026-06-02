import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, "..");
const bin = resolve(cliDir, "dist/bin/run.js");
const tools = resolve(cliDir, "fixtures/tools.json");
const script = resolve(cliDir, "fixtures/script.jsonl");
const perms = resolve(cliDir, "fixtures/perms.json");
const permsDeny = resolve(cliDir, "fixtures/perms-deny-calc.json");

describe("CLI smoke test", () => {
  it("builds successfully", () => {
    expect(existsSync(bin)).toBe(true);
  });

  it("runs without crashing", () => {
    const result = execSync(`node ${bin} ${tools} ${script} ${perms} cli-test`, {
      encoding: "utf-8",
    });
    expect(result).toContain("RUN START");
    expect(result).toContain("calculator");
    expect(result).toContain("RUN END");
  });

  it("shows permission denied when tool is blocked", () => {
    const result = execSync(
      `node ${bin} ${tools} ${script} ${permsDeny} cli-test-deny`,
      { encoding: "utf-8" }
    );
    expect(result).toContain("permission denied");
  });

  it("normal run exits 0", () => {
    let status: number | null = null;
    let output = "";
    try {
      output = execSync(
        `node ${bin} ${tools} ${script} ${perms} cli-test-exit-ok`,
        { encoding: "utf-8" }
      );
      status = 0;
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer | string };
      status = e.status ?? 1;
      output = String(e.stdout ?? "");
    }
    expect(status).toBe(0);
    expect(output).toContain("RUN END");
  });
});

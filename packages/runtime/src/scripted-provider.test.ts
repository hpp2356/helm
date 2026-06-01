import { describe, it, expect } from "vitest";
import { ScriptedProvider } from "./scripted-provider.js";

describe("ScriptedProvider", () => {
  it("returns responses in order", async () => {
    const p = new ScriptedProvider([
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    const r1 = await p.send([{ role: "user", content: "hi" }]);
    expect(r1).toEqual({ role: "assistant", content: "first" });
    const r2 = await p.send([{ role: "user", content: "again" }]);
    expect(r2).toEqual({ role: "assistant", content: "second" });
  });

  it("throws when exhausted", async () => {
    const p = new ScriptedProvider([{ role: "assistant", content: "only" }]);
    await p.send([]);
    await expect(p.send([])).rejects.toThrow("ScriptedProvider exhausted");
  });

  it("implements Provider interface (compile-time check)", () => {
    const p = new ScriptedProvider([]);
    expect(typeof p.send).toBe("function");
  });
});

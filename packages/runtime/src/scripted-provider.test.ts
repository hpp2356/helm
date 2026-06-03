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

  it("throws HelmError on error entry", async () => {
    const p = new ScriptedProvider([
      {
        _error: true,
        message: "rate limit hit",
        category: "rate_limit",
      },
      { role: "assistant", content: "next" },
    ]);
    await expect(
      p.send([{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({
      name: "HelmError",
      message: "rate limit hit",
    });
    // Next call returns the success entry (index advanced past error).
    const r = await p.send([{ role: "user", content: "hi" }]);
    expect(r).toEqual({ role: "assistant", content: "next" });
  });

  it("stacks multiple error entries for consecutive failures", async () => {
    const p = new ScriptedProvider([
      { _error: true, message: "fail 1", category: "server_error" },
      { _error: true, message: "fail 2", category: "server_error" },
      { role: "assistant", content: "success" },
    ]);
    await expect(p.send([])).rejects.toMatchObject({ message: "fail 1" });
    await expect(p.send([])).rejects.toMatchObject({ message: "fail 2" });
    const r = await p.send([]);
    expect(r).toEqual({ role: "assistant", content: "success" });
  });
});

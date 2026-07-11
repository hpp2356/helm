import { describe, it, expect, vi } from "vitest";
import { StreamingBus, type StreamingEvent, type StreamingStats } from "./streaming.js";

describe("StreamingBus", () => {
  it("emit → subscriber receives event", () => {
    const bus = new StreamingBus();
    const received: StreamingEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: "text_delta", text: "hello" });

    expect(received).toEqual([{ type: "text_delta", text: "hello" }]);
  });

  it("multiple subscribers → all receive events", () => {
    const bus = new StreamingBus();
    const a: StreamingEvent[] = [];
    const b: StreamingEvent[] = [];
    bus.on((e) => a.push(e));
    bus.on((e) => b.push(e));

    bus.emit({ type: "text_delta", text: "x" });
    bus.emit({ type: "text_delta", text: "y" });

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]).toEqual({ type: "text_delta", text: "x" });
    expect(b[1]).toEqual({ type: "text_delta", text: "y" });
  });

  it("unsubscribe → no longer receives events", () => {
    const bus = new StreamingBus();
    const received: StreamingEvent[] = [];
    const unsub = bus.on((e) => received.push(e));

    bus.emit({ type: "text_delta", text: "a" });
    unsub();
    bus.emit({ type: "text_delta", text: "b" });

    expect(received).toEqual([{ type: "text_delta", text: "a" }]);
  });

  it("listenerCount tracks active subscribers", () => {
    const bus = new StreamingBus();
    expect(bus.listenerCount).toBe(0);

    const unsub1 = bus.on(() => {});
    expect(bus.listenerCount).toBe(1);

    const unsub2 = bus.on(() => {});
    expect(bus.listenerCount).toBe(2);

    unsub1();
    expect(bus.listenerCount).toBe(1);

    unsub2();
    expect(bus.listenerCount).toBe(0);
  });

  describe("stats", () => {
    it("counts text_delta events and tokens", () => {
      const bus = new StreamingBus();
      bus.emit({ type: "text_delta", text: "hello" });
      bus.emit({ type: "text_delta", text: " world" });

      expect(bus.stats.textTokens).toBe(11); // "hello" + " world"
      expect(bus.stats.textDeltaCount).toBe(2);
    });

    it("counts tool_call_delta events", () => {
      const bus = new StreamingBus();
      bus.emit({ type: "tool_call_delta", id: "tc1", name: "read_file", argumentsDelta: "{}" });

      expect(bus.stats.toolCallDeltas).toBe(1);
      expect(bus.stats.toolCallDeltaCount).toBe(1);
    });

    it("counts thinking_delta events and tokens", () => {
      const bus = new StreamingBus();
      bus.emit({ type: "thinking_delta", text: "let me think" });
      bus.emit({ type: "thinking_delta", text: " about this" });

      expect(bus.stats.thinkingTokens).toBe(23); // "let me think" (12) + " about this" (11)
      expect(bus.stats.thinkingDeltaCount).toBe(2);
    });

    it("turn_start / turn_end don't affect stats", () => {
      const bus = new StreamingBus();
      bus.emit({ type: "turn_start", turnIndex: 0 });
      bus.emit({ type: "turn_end", turnIndex: 0 });

      expect(bus.stats.textTokens).toBe(0);
      expect(bus.stats.toolCallDeltas).toBe(0);
      expect(bus.stats.thinkingTokens).toBe(0);
    });

    it("resetStats clears all counters", () => {
      const bus = new StreamingBus();
      bus.emit({ type: "text_delta", text: "hello" });
      bus.emit({ type: "tool_call_delta", id: "tc1", name: "x", argumentsDelta: "" });
      bus.emit({ type: "thinking_delta", text: "hmm" });

      bus.resetStats();

      const expected: StreamingStats = {
        textTokens: 0,
        toolCallDeltas: 0,
        thinkingTokens: 0,
        textDeltaCount: 0,
        toolCallDeltaCount: 0,
        thinkingDeltaCount: 0,
      };
      expect(bus.stats).toEqual(expected);
    });

    it("stats accumulate across multiple emit calls", () => {
      const bus = new StreamingBus();
      for (let i = 0; i < 100; i++) {
        bus.emit({ type: "text_delta", text: "a" });
      }

      expect(bus.stats.textTokens).toBe(100);
      expect(bus.stats.textDeltaCount).toBe(100);
    });
  });

  it("sync emit — handlers run inline", () => {
    const bus = new StreamingBus();
    const order: string[] = [];

    bus.on(() => order.push("handler1"));
    bus.on(() => order.push("handler2"));

    order.push("before");
    bus.emit({ type: "text_delta", text: "x" });
    order.push("after");

    expect(order).toEqual(["before", "handler1", "handler2", "after"]);
  });
});

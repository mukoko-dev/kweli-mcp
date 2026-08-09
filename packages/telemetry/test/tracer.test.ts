import { describe, expect, it, vi } from "vitest";

import { MemorySink, MultiSink } from "../src/sinks";
import { Tracer } from "../src/tracer";
import type { Sink } from "../src/types";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function tracer(sink = new MemorySink()) {
  return { sink, t: new Tracer({ serviceName: "test-agent", instanceId: "task-1", sink }) };
}

describe("log records", () => {
  it("stamps service, instance and trace identity on every event", () => {
    const { sink, t } = tracer();
    t.info("place.written", { placeId: "p1" });

    expect(sink.events).toHaveLength(1);
    const e = sink.events[0]!;
    expect(e.serviceName).toBe("test-agent");
    expect(e.instanceId).toBe("task-1");
    expect(e.name).toBe("place.written");
    expect(e.severity).toBe("info");
    expect(e.attributes).toEqual({ placeId: "p1" });
    expect(e.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(e.durationMs).toBeNull();
    expect(e.status).toBeNull();
  });

  it("records each severity", () => {
    const { sink, t } = tracer();
    t.debug("d");
    t.info("i");
    t.warn("w");
    t.error("e");
    expect(sink.events.map((e) => e.severity)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("extracts type and message from an Error", () => {
    const { sink, t } = tracer();
    t.error("write.failed", new TypeError("bad shape"), { placeId: "p1" });

    expect(sink.events[0]!.attributes).toEqual({
      "error.type": "TypeError",
      "error.message": "bad shape",
      placeId: "p1",
    });
  });

  it("keeps stack traces out of attributes by default", () => {
    // These events can land in a shared table; a stack is a classic accidental
    // leak of internal paths.
    const { sink, t } = tracer();
    t.error("boom", new Error("kaboom"));
    expect(JSON.stringify(sink.events[0]!.attributes)).not.toContain("at ");
    expect(sink.events[0]!.attributes).not.toHaveProperty("error.stack");
  });

  it("handles a non-Error throwable", () => {
    const { sink, t } = tracer();
    t.error("boom", "just a string");
    expect(sink.events[0]!.attributes["error.message"]).toBe("just a string");
  });

  it("merges tracer-level attributes into every event", () => {
    const sink = new MemorySink();
    const t = new Tracer({ serviceName: "s", sink, attributes: { region: "zw" } });
    t.info("x", { extra: 1 });
    expect(sink.events[0]!.attributes).toEqual({ region: "zw", extra: 1 });
  });
});

describe("spans", () => {
  it("times the body and returns its value", async () => {
    const { sink, t } = tracer();
    const result = await t.span("overpass.lookup", async () => "features");

    expect(result).toBe("features");
    const e = sink.events[0]!;
    expect(e.name).toBe("overpass.lookup");
    expect(e.status).toBe("ok");
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a synchronous body", async () => {
    const { sink, t } = tracer();
    expect(await t.span("sync", () => 42)).toBe(42);
    expect(sink.events[0]!.status).toBe("ok");
  });

  it("records a failure and re-raises unchanged", async () => {
    // A span observes; it must never alter control flow.
    const { sink, t } = tracer();
    const boom = new Error("overpass down");

    await expect(
      t.span("overpass.lookup", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const e = sink.events[0]!;
    expect(e.status).toBe("error");
    expect(e.severity).toBe("error");
    expect(e.attributes["error.message"]).toBe("overpass down");
  });

  it("nests spans into a tree under one trace", async () => {
    const { sink, t } = tracer();

    await t.span("outer", async (outer) => {
      await outer.span("inner", async () => undefined);
    });

    const [inner, outer] = sink.events; // inner completes first
    expect(inner!.name).toBe("inner");
    expect(outer!.name).toBe("outer");
    // Same trace, distinct spans, and inner's parent is outer.
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.spanId).not.toBe(outer!.spanId);
    expect(inner!.parentSpanId).toBe(outer!.spanId);
  });
});

describe("propagation", () => {
  it("continues a trace arriving over HTTP", () => {
    const sink = new MemorySink();
    const request = new Request("https://example.test/tasks", {
      headers: { traceparent: VALID },
    });
    const t = Tracer.fromRequest(request, { serviceName: "agent", sink });

    t.info("received");
    expect(sink.events[0]!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(sink.events[0]!.parentSpanId).toBe("00f067aa0ba902b7");
  });

  it("emits outbound headers that carry the trace onward", () => {
    const { t } = tracer();
    const headers = t.outboundHeaders({ authorization: "Bearer x" });

    expect(headers.get("authorization")).toBe("Bearer x");
    expect(headers.get("traceparent")).toContain(t.context.traceId);
  });

  it("propagates through tracer.fetch", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response("ok");
    });

    const { t } = tracer();
    await t.fetch("https://example.test", { method: "POST" });

    expect(seen[0]!.get("traceparent")).toContain(t.context.traceId);
    vi.unstubAllGlobals();
  });

  it("survives a full hop: service A → header → service B", () => {
    // The end-to-end property everything else depends on.
    const sinkA = new MemorySink();
    const sinkB = new MemorySink();

    const a = new Tracer({ serviceName: "mcp", sink: sinkA });
    a.info("calling agent");

    const request = new Request("https://agent.test/tasks", {
      headers: a.outboundHeaders(),
    });
    const b = Tracer.fromRequest(request, { serviceName: "agent", sink: sinkB });
    b.info("handling");

    expect(sinkB.events[0]!.traceId).toBe(sinkA.events[0]!.traceId);
    expect(sinkB.events[0]!.parentSpanId).toBe(a.context.spanId);
  });
});

describe("resilience", () => {
  it("never lets a broken sink reach the caller", () => {
    const exploding: Sink = {
      emit() {
        throw new Error("sink is down");
      },
    };
    const t = new Tracer({ serviceName: "s", sink: exploding });
    expect(() => t.info("still fine")).not.toThrow();
  });

  it("keeps delivering to healthy sinks when one fails", () => {
    const healthy = new MemorySink();
    const exploding: Sink = {
      emit() {
        throw new Error("down");
      },
    };
    const t = new Tracer({ serviceName: "s", sink: new MultiSink([exploding, healthy]) });

    t.info("delivered");
    expect(healthy.events).toHaveLength(1);
  });

  it("still returns the span's value when the sink is broken", async () => {
    const exploding: Sink = {
      emit() {
        throw new Error("down");
      },
    };
    const t = new Tracer({ serviceName: "s", sink: exploding });
    await expect(t.span("work", async () => "result")).resolves.toBe("result");
  });
});

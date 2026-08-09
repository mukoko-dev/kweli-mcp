import { describe, expect, it, vi } from "vitest";

import { buildSink } from "../src/factory";
import { ConsoleSink, D1Sink, MemorySink, MultiSink, OtlpSink } from "../src/sinks";
import type { TelemetryEvent } from "../src/types";

const EVENT: TelemetryEvent = {
  timestamp: "2026-08-09T06:00:00.000Z",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "aaaaaaaaaaaaaaaa",
  serviceName: "kweli-bulk-place-agent",
  instanceId: "task-42",
  severity: "info",
  name: "place.written",
  durationMs: 120,
  status: "ok",
  attributes: { placeId: "p1", count: 3 },
};

function fakeD1() {
  const calls: { query: string; values: unknown[] }[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              calls.push({ query, values });
              return {};
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

describe("ConsoleSink", () => {
  it("writes one JSON line, routed by severity", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const sink = new ConsoleSink();
    sink.emit(EVENT);
    sink.emit({ ...EVENT, severity: "warn" });
    sink.emit({ ...EVENT, severity: "error" });

    expect(JSON.parse(log.mock.calls[0]![0] as string).name).toBe("place.written");
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});

describe("D1Sink", () => {
  it("writes every column in the order the table declares", async () => {
    const { db, calls } = fakeD1();
    const pending: Promise<unknown>[] = [];

    new D1Sink({ db, waitUntil: (p) => pending.push(p) }).emit(EVENT);
    await Promise.all(pending);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("INSERT INTO agent_events");
    expect(calls[0]!.values).toEqual([
      "2026-08-09T06:00:00.000Z",
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "00f067aa0ba902b7",
      "aaaaaaaaaaaaaaaa",
      "kweli-bulk-place-agent",
      "task-42",
      "info",
      "place.written",
      120,
      "ok",
      JSON.stringify({ placeId: "p1", count: 3 }),
    ]);
  });

  it("registers the write with waitUntil so it survives the response", () => {
    // Without this a fire-and-forget insert can be cancelled when the isolate
    // is torn down — the classic "logs missing exactly when it crashed".
    const { db } = fakeD1();
    const waitUntil = vi.fn();
    new D1Sink({ db, waitUntil }).emit(EVENT);
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("swallows a write failure but reports it to stdout", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => Promise.reject(new Error("no such table")) }),
      }),
    };
    const pending: Promise<unknown>[] = [];

    expect(() =>
      new D1Sink({ db, waitUntil: (p) => pending.push(p) }).emit(EVENT),
    ).not.toThrow();
    await Promise.all(pending);

    // Never surfaces — but doesn't vanish either, or a broken telemetry table
    // becomes invisible precisely when it's needed.
    expect(JSON.parse(error.mock.calls[0]![0] as string).event).toBe(
      "telemetry.d1_write_failed",
    );
    vi.restoreAllMocks();
  });
});

describe("OtlpSink", () => {
  it("posts an OTLP/HTTP logs payload with trace identity intact", async () => {
    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string) });
      return new Response("{}");
    });

    const pending: Promise<unknown>[] = [];
    new OtlpSink({
      endpoint: "https://otlp.test/v1/logs",
      headers: { authorization: "Bearer k" },
      waitUntil: (p) => pending.push(p),
    }).emit(EVENT);
    await Promise.all(pending);

    const body = seen[0]!.body as any;
    const resource = body.resourceLogs[0];
    const record = resource.scopeLogs[0].logRecords[0];

    expect(seen[0]!.url).toBe("https://otlp.test/v1/logs");
    expect(resource.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "kweli-bulk-place-agent" },
    });
    expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("INFO");

    vi.unstubAllGlobals();
  });

  it("encodes attribute values by JSON type", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return new Response("{}");
    });

    const pending: Promise<unknown>[] = [];
    new OtlpSink({ endpoint: "https://otlp.test/v1/logs", waitUntil: (p) => pending.push(p) }).emit(
      {
        ...EVENT,
        attributes: { s: "x", n: 3, f: 1.5, b: true, o: { nested: 1 } },
      },
    );
    await Promise.all(pending);

    const attrs = seen[0].resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const by = (k: string) => attrs.find((a: any) => a.key === k).value;

    expect(by("s")).toEqual({ stringValue: "x" });
    expect(by("n")).toEqual({ intValue: 3 });
    expect(by("f")).toEqual({ doubleValue: 1.5 });
    expect(by("b")).toEqual({ boolValue: true });
    expect(by("o")).toEqual({ stringValue: '{"nested":1}' });

    vi.unstubAllGlobals();
  });

  it("never surfaces a backend outage", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("network down")));
    const pending: Promise<unknown>[] = [];
    expect(() =>
      new OtlpSink({ endpoint: "https://otlp.test", waitUntil: (p) => pending.push(p) }).emit(EVENT),
    ).not.toThrow();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe("MultiSink", () => {
  it("delivers to all sinks", () => {
    const a = new MemorySink();
    const b = new MemorySink();
    new MultiSink([a, b]).emit(EVENT);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });
});

describe("buildSink", () => {
  it("falls back to console alone when nothing is configured", () => {
    // An unconfigured service degrades to structured stdout, never an error.
    expect(buildSink()).toBeInstanceOf(ConsoleSink);
    expect(buildSink({ env: {} })).toBeInstanceOf(ConsoleSink);
  });

  it("adds the D1 sink when a binding is present", () => {
    const { db } = fakeD1();
    expect(buildSink({ env: { DB: db } })).toBeInstanceOf(MultiSink);
  });

  it("honours the D1 kill switch without removing the binding", () => {
    const { db } = fakeD1();
    expect(buildSink({ env: { DB: db, TELEMETRY_D1_DISABLED: "true" } })).toBeInstanceOf(
      ConsoleSink,
    );
  });

  it("adds the OTLP sink when an endpoint is set", () => {
    expect(buildSink({ env: { OTLP_ENDPOINT: "https://otlp.test" } })).toBeInstanceOf(MultiSink);
  });

  it("parses OTLP headers, tolerating values that contain '='", () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}");
    });

    const pending: Promise<unknown>[] = [];
    buildSink({
      env: {
        OTLP_ENDPOINT: "https://otlp.test",
        OTLP_HEADERS: "Authorization=Bearer abc=def, x-org = 12 ",
      },
      waitUntil: (p) => pending.push(p),
    }).emit(EVENT);

    const headers = seen[0]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer abc=def");
    expect(headers["x-org"]).toBe("12");

    vi.unstubAllGlobals();
  });
});

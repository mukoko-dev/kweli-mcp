import { describe, expect, it } from "vitest";

import {
  contextFromHeaders,
  formatTraceparent,
  injectTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from "../src/trace-context";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  it("parses a valid W3C header", () => {
    const ctx = parseTraceparent(VALID);
    expect(ctx).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("reads the sampled bit", () => {
    expect(parseTraceparent(VALID.replace(/-01$/, "-00"))?.sampled).toBe(false);
    // Bit 0 is what matters; other bits are reserved and must not confuse us.
    expect(parseTraceparent(VALID.replace(/-01$/, "-03"))?.sampled).toBe(true);
    expect(parseTraceparent(VALID.replace(/-01$/, "-02"))?.sampled).toBe(false);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseTraceparent(`  ${VALID.toUpperCase()}  `)?.traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["not a traceparent", "garbage"],
    ["unsupported version", "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["short trace id", "00-4bf92f3577b34da6-00f067aa0ba902b7-01"],
    ["non-hex", "00-zzzz2f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["missing flags", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"],
  ])("rejects %s", (_label, value) => {
    expect(parseTraceparent(value as string | null | undefined)).toBeNull();
  });

  it("rejects all-zero ids rather than propagating a broken trace", () => {
    // The spec requires this. Adopting an all-zero id would silently merge
    // every request from a broken upstream into one meaningless trace.
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`)).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("round-trips", () => {
    expect(formatTraceparent(parseTraceparent(VALID)!)).toBe(VALID);
  });

  it("encodes the unsampled flag", () => {
    expect(
      formatTraceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: false }),
    ).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`);
  });
});

describe("id generation", () => {
  it("produces spec-shaped ids", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, newTraceId));
    expect(ids.size).toBe(500);
  });
});

describe("contextFromHeaders", () => {
  it("continues an inbound trace under a fresh span", () => {
    const headers = new Headers({ traceparent: VALID });
    const { context, parentSpanId } = contextFromHeaders(headers);

    expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parentSpanId).toBe("00f067aa0ba902b7");
    // A fresh span id is the point: this service's work is its own span, and
    // reusing the caller's id would collapse caller and callee into one node.
    expect(context.spanId).not.toBe("00f067aa0ba902b7");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("starts a new trace when there is no header", () => {
    const { context, parentSpanId } = contextFromHeaders(new Headers());
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parentSpanId).toBeNull();
    expect(context.sampled).toBe(true);
  });

  it("starts a new trace when the header is malformed", () => {
    const { context, parentSpanId } = contextFromHeaders(new Headers({ traceparent: "junk" }));
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parentSpanId).toBeNull();
  });
});

describe("injectTraceparent", () => {
  it("adds the header while preserving existing ones", () => {
    const headers = injectTraceparent({ authorization: "Bearer x" }, parseTraceparent(VALID)!);
    expect(headers.get("authorization")).toBe("Bearer x");
    expect(headers.get("traceparent")).toBe(VALID);
  });

  it("overwrites a stale traceparent rather than duplicating it", () => {
    const headers = injectTraceparent(
      { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      parseTraceparent(VALID)!,
    );
    expect(headers.get("traceparent")).toBe(VALID);
  });
});

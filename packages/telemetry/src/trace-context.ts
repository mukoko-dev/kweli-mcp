// W3C Trace Context — the one thing that makes cross-service debugging work.
//
// https://www.w3.org/TR/trace-context/
//
// A `traceparent` header carries a trace id across every service boundary,
// so one user action ("create an event, whose venue isn't in the graph yet")
// stays a single correlatable thread as it crosses nhimbe → api-gateway →
// kweli-mcp → single-place-agent → Mongo. Without propagation you have five
// piles of logs and no way to line them up.
//
// Format: `version-traceId-spanId-flags`, e.g.
//   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//    │  └ 32 hex (16 bytes)              └ 16 hex (8 bytes)  └ sampled bit
//    └ version, always 00 today

export interface TraceContext {
  traceId: string;
  spanId: string;
  /** True when the trace is sampled — bit 0 of the flags byte. */
  sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

/** Parse a `traceparent` value. Returns null for anything malformed. */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;

  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return null;

  const [, traceId, spanId, flags] = match;
  // The spec requires rejecting all-zero ids rather than propagating them —
  // they signal a broken upstream, and adopting one would silently merge
  // every such request into a single meaningless "trace".
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;

  return {
    traceId: traceId!,
    spanId: spanId!,
    sampled: (parseInt(flags!, 16) & 0x01) === 1,
  };
}

/** Serialise a context back into a `traceparent` header value. */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/**
 * Continue an inbound trace, or start a new one.
 *
 * Always returns a *fresh* span id: this service's work is a new span, and
 * the caller's span id becomes its parent. Reusing the inbound span id would
 * collapse caller and callee into one node.
 */
export function contextFromHeaders(headers: Headers): {
  context: TraceContext;
  parentSpanId: string | null;
} {
  const parent = parseTraceparent(headers.get("traceparent"));

  if (parent) {
    return {
      context: { traceId: parent.traceId, spanId: newSpanId(), sampled: parent.sampled },
      parentSpanId: parent.spanId,
    };
  }

  return {
    context: { traceId: newTraceId(), spanId: newSpanId(), sampled: true },
    parentSpanId: null,
  };
}

/**
 * Inject trace context into outbound request headers.
 *
 * Every `fetch` that leaves a service must carry this or the trace stops at
 * the boundary — which is precisely where distributed debugging gets hard.
 */
export function injectTraceparent(
  headers: HeadersInit | undefined,
  ctx: TraceContext,
): Headers {
  const out = new Headers(headers);
  out.set("traceparent", formatTraceparent(ctx));
  return out;
}

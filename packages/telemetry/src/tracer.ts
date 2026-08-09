// The API call sites use.
//
// Two shapes, matching how the existing code already logs:
//
//   tracer.info("place.written", { placeId })   ← replaces console.log/JSON
//   await tracer.span("overpass.lookup", fn)    ← replaces `measure()`
//
// Everything carries trace context automatically, so adopting this is a
// mechanical swap at each call site rather than a redesign.

import { ConsoleSink } from "./sinks";
import {
  contextFromHeaders,
  injectTraceparent,
  newSpanId,
  newTraceId,
  type TraceContext,
} from "./trace-context";
import type { Attributes, Severity, Sink, TelemetryEvent } from "./types";

export interface TracerOptions {
  /** The agent id — becomes `service.name`. */
  serviceName: string;
  /** Durable Object name / instance discriminator. */
  instanceId?: string | null;
  sink?: Sink;
  context?: TraceContext;
  parentSpanId?: string | null;
  /** Merged into every event this tracer emits. */
  attributes?: Attributes;
}

function errorAttributes(error: unknown): Attributes {
  if (error instanceof Error) {
    return {
      "error.type": error.name,
      "error.message": error.message,
      // Stack stays out of `attributes` by default — these events can land in
      // a shared table and a stack is the classic accidental leak of internal
      // paths. Callers who want it can pass it explicitly.
    };
  }
  return { "error.type": "unknown", "error.message": String(error) };
}

export class Tracer {
  readonly serviceName: string;
  readonly instanceId: string | null;
  readonly context: TraceContext;
  readonly parentSpanId: string | null;

  private readonly sink: Sink;
  private readonly baseAttributes: Attributes;

  constructor(options: TracerOptions) {
    this.serviceName = options.serviceName;
    this.instanceId = options.instanceId ?? null;
    this.sink = options.sink ?? new ConsoleSink();
    this.baseAttributes = options.attributes ?? {};
    this.context =
      options.context ?? { traceId: newTraceId(), spanId: newSpanId(), sampled: true };
    this.parentSpanId = options.parentSpanId ?? null;
  }

  /** Continue a trace arriving over HTTP, or start one if there's no header. */
  static fromRequest(
    request: Request,
    options: Omit<TracerOptions, "context" | "parentSpanId">,
  ): Tracer {
    const { context, parentSpanId } = contextFromHeaders(request.headers);
    return new Tracer({ ...options, context, parentSpanId });
  }

  /**
   * A tracer for a child unit of work — new span id, same trace, current span
   * as parent. This is what builds the tree rather than a flat list.
   */
  child(options: Partial<TracerOptions> = {}): Tracer {
    return new Tracer({
      serviceName: options.serviceName ?? this.serviceName,
      instanceId: options.instanceId ?? this.instanceId,
      sink: options.sink ?? this.sink,
      attributes: { ...this.baseAttributes, ...options.attributes },
      context: { ...this.context, spanId: newSpanId() },
      parentSpanId: this.context.spanId,
    });
  }

  /** Headers for an outbound fetch, carrying this trace across the boundary. */
  outboundHeaders(headers?: HeadersInit): Headers {
    return injectTraceparent(headers, this.context);
  }

  /** A fetch that propagates trace context. Prefer this over bare `fetch`. */
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    return fetch(input, { ...init, headers: this.outboundHeaders(init.headers) });
  }

  debug(name: string, attributes?: Attributes): void {
    this.emit("debug", name, attributes);
  }

  info(name: string, attributes?: Attributes): void {
    this.emit("info", name, attributes);
  }

  warn(name: string, attributes?: Attributes): void {
    this.emit("warn", name, attributes);
  }

  error(name: string, error?: unknown, attributes?: Attributes): void {
    this.emit("error", name, {
      ...(error === undefined ? {} : errorAttributes(error)),
      ...attributes,
    });
  }

  /**
   * Time a unit of work and record it as a span.
   *
   * Re-raises whatever the body threw — a span records what happened, it
   * never changes it. The failing span is emitted before the re-throw so an
   * error is never silently untraced.
   */
  async span<T>(
    name: string,
    fn: (span: Tracer) => Promise<T> | T,
    attributes?: Attributes,
  ): Promise<T> {
    const span = this.child({ attributes });
    const startedAt = Date.now();

    try {
      const result = await fn(span);
      span.emitSpan(name, Date.now() - startedAt, "ok", {});
      return result;
    } catch (error) {
      span.emitSpan(name, Date.now() - startedAt, "error", errorAttributes(error));
      throw error;
    }
  }

  private emit(severity: Severity, name: string, attributes: Attributes = {}): void {
    this.write({
      timestamp: new Date().toISOString(),
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      serviceName: this.serviceName,
      instanceId: this.instanceId,
      severity,
      name,
      durationMs: null,
      status: null,
      attributes: { ...this.baseAttributes, ...attributes },
    });
  }

  private emitSpan(
    name: string,
    durationMs: number,
    status: "ok" | "error",
    attributes: Attributes,
  ): void {
    this.write({
      timestamp: new Date().toISOString(),
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      serviceName: this.serviceName,
      instanceId: this.instanceId,
      severity: status === "error" ? "error" : "info",
      name,
      durationMs,
      status,
      attributes: { ...this.baseAttributes, ...attributes },
    });
  }

  private write(event: TelemetryEvent): void {
    try {
      this.sink.emit(event);
    } catch {
      // Telemetry must never break the thing it observes.
    }
  }
}

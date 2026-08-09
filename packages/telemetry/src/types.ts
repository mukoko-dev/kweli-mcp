// The event shape everything in this package emits, deliberately mapped onto
// OpenTelemetry's data model so it can be exported as OTLP without a
// translation layer:
//
//   serviceName   → Resource attribute `service.name`
//   instanceId    → Resource attribute `service.instance.id`
//   traceId/spanId/parentSpanId → Span identity
//   severity      → LogRecord SeverityText
//   attributes    → Span/LogRecord attributes
//
// We emit this shape rather than pulling in the OpenTelemetry SDK because the
// SDK is heavy in a Workers isolate (Node-shaped async_hooks context
// propagation, a batching exporter, a large dependency tree) for what is, at
// this scale, one header and a JSON write. The wire format stays OTLP-
// compatible, so swapping a real exporter in later is additive.

export type Severity = "debug" | "info" | "warn" | "error";

/** OTel SeverityNumber, for OTLP export. */
export const SEVERITY_NUMBER: Record<Severity, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

export type Attributes = Record<string, unknown>;

export interface TelemetryEvent {
  /** ISO 8601, always UTC. */
  timestamp: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** The agent/worker/app emitting this — your "agent id". */
  serviceName: string;
  /**
   * The specific instance. For a Cloudflare Agent this is the Durable Object
   * name, which for bulk-place-agent IS the taskId — so per-task tracking
   * falls out for free and joins straight to the D1 `tasks` ledger.
   */
  instanceId: string | null;
  severity: Severity;
  /** Span name for spans; log message for standalone events. */
  name: string;
  /** Present only on completed spans. */
  durationMs: number | null;
  /** "ok" | "error" for spans; null for log records. */
  status: "ok" | "error" | null;
  attributes: Attributes;
}

export interface Sink {
  /**
   * Record one event. Implementations MUST NOT throw and MUST NOT block the
   * caller's critical path — telemetry that can break the request it observes
   * is worse than no telemetry.
   */
  emit(event: TelemetryEvent): void;
}

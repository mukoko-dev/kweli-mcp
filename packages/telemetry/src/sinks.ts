// Sinks — where events actually land.
//
// Layered on purpose. Console is always on and free; the D1 sink gives the
// queryable per-agent table; OTLP ships to whatever backend gets chosen.
// A sink failing must never surface to the caller, so every one of these
// swallows its own errors.

import type { Attributes, Sink, TelemetryEvent } from "./types";
import { SEVERITY_NUMBER } from "./types";

/**
 * Structured JSON to stdout.
 *
 * Cloudflare Workers Logs, Vercel and Fly all ingest stdout, so this alone
 * makes every service queryable in its platform console with no vendor and no
 * config. It is the floor, not the ceiling.
 */
export class ConsoleSink implements Sink {
  emit(event: TelemetryEvent): void {
    const line = JSON.stringify(event);
    // Route by severity so platform log levels line up.
    if (event.severity === "error") console.error(line);
    else if (event.severity === "warn") console.warn(line);
    else console.log(line);
  }
}

export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

export interface D1SinkOptions {
  db: D1Like;
  /**
   * Registers the write with the runtime so the isolate isn't torn down
   * mid-insert. In a Worker pass `ctx.waitUntil`. Without it a fire-and-forget
   * write can be cancelled when the response returns — the classic cause of
   * "the logs are missing exactly when it crashed".
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Durable per-agent event log in D1 — the queryable table.
 *
 * One table, not one per agent. `service_name` gives you the per-agent view
 * with a WHERE clause, while `trace_id` still lets you reconstruct a single
 * request across every service it touched. Table-per-agent optimises the easy
 * query and makes the hard one (a cross-service trace) a growing UNION.
 */
export class D1Sink implements Sink {
  constructor(private readonly options: D1SinkOptions) {}

  emit(event: TelemetryEvent): void {
    const write = this.options.db
      .prepare(
        `INSERT INTO agent_events (
           timestamp, trace_id, span_id, parent_span_id,
           service_name, instance_id, severity, name,
           duration_ms, status, attributes_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        event.timestamp,
        event.traceId,
        event.spanId,
        event.parentSpanId,
        event.serviceName,
        event.instanceId,
        event.severity,
        event.name,
        event.durationMs,
        event.status,
        JSON.stringify(event.attributes),
      )
      .run()
      .catch((error: unknown) => {
        // Never surface — but don't vanish either, or a broken telemetry
        // table becomes invisible precisely when it's needed.
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            serviceName: event.serviceName,
            event: "telemetry.d1_write_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });

    this.options.waitUntil?.(write);
  }
}

export interface OtlpSinkOptions {
  /** Full OTLP/HTTP logs endpoint, e.g. https://otlp.example/v1/logs */
  endpoint: string;
  headers?: Record<string, string>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

function toAnyValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  return { stringValue: JSON.stringify(value) };
}

function toKeyValues(attributes: Attributes): Array<Record<string, unknown>> {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toAnyValue(value),
  }));
}

/**
 * OTLP/HTTP JSON export — one record per call.
 *
 * Deliberately unbatched: a Workers isolate has no reliable "flush on
 * shutdown" hook, so a batch buffer is a good way to lose the events you most
 * wanted. If volume ever justifies batching, do it in a Tail Worker where the
 * lifecycle is actually yours.
 */
export class OtlpSink implements Sink {
  constructor(private readonly options: OtlpSinkOptions) {}

  emit(event: TelemetryEvent): void {
    const body = {
      resourceLogs: [
        {
          resource: {
            attributes: toKeyValues({
              "service.name": event.serviceName,
              ...(event.instanceId ? { "service.instance.id": event.instanceId } : {}),
            }),
          },
          scopeLogs: [
            {
              scope: { name: "@kweli-mcp/telemetry" },
              logRecords: [
                {
                  timeUnixNano: `${Date.parse(event.timestamp)}000000`,
                  severityText: event.severity.toUpperCase(),
                  severityNumber: SEVERITY_NUMBER[event.severity],
                  body: toAnyValue(event.name),
                  traceId: event.traceId,
                  spanId: event.spanId,
                  attributes: toKeyValues({
                    ...event.attributes,
                    ...(event.parentSpanId ? { "parent.span_id": event.parentSpanId } : {}),
                    ...(event.durationMs !== null ? { "duration.ms": event.durationMs } : {}),
                    ...(event.status ? { "span.status": event.status } : {}),
                  }),
                },
              ],
            },
          ],
        },
      ],
    };

    const send = fetch(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      body: JSON.stringify(body),
    }).catch(() => {
      // A telemetry backend being down must never affect the request.
    });

    this.options.waitUntil?.(send);
  }
}

/** Fan out to several sinks; one failing never stops the others. */
export class MultiSink implements Sink {
  constructor(private readonly sinks: Sink[]) {}

  emit(event: TelemetryEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // Swallowed by contract.
      }
    }
  }
}

/** Collects events in memory. For tests and local inspection. */
export class MemorySink implements Sink {
  readonly events: TelemetryEvent[] = [];

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

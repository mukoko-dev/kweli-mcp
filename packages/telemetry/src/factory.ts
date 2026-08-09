// One-call wiring, so adopting telemetry in a Worker is a single line rather
// than a decision tree at every entry point.
//
//   const tracer = tracerForRequest(request, {
//     serviceName: "kweli-single-place-agent",
//     env,
//     waitUntil: ctx.waitUntil.bind(ctx),
//   });
//
// Which sinks light up is driven entirely by what's configured in `env`:
// console always, D1 when a `DB` binding exists, OTLP when an endpoint is
// set. An unconfigured service degrades to structured stdout, never to an
// error — the same "absent config is not a failure" contract the rest of this
// codebase follows.

import { ConsoleSink, D1Sink, MultiSink, OtlpSink, type D1Like } from "./sinks";
import { newSpanId } from "./trace-context";
import { Tracer } from "./tracer";
import type { Attributes, Sink } from "./types";

export interface TelemetryEnv {
  /** D1 binding. When present, events are also written to `agent_events`. */
  DB?: D1Like;
  /** Full OTLP/HTTP logs endpoint. When set, events are also exported. */
  OTLP_ENDPOINT?: string;
  /** e.g. "Authorization=Bearer xyz,x-org=123" */
  OTLP_HEADERS?: string;
  /** Disables the D1 sink without removing the binding. */
  TELEMETRY_D1_DISABLED?: string;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

export interface BuildSinkOptions {
  env?: TelemetryEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function buildSink({ env, waitUntil }: BuildSinkOptions = {}): Sink {
  const sinks: Sink[] = [new ConsoleSink()];

  if (env?.DB && env.TELEMETRY_D1_DISABLED !== "true") {
    sinks.push(new D1Sink({ db: env.DB, waitUntil }));
  }

  if (env?.OTLP_ENDPOINT) {
    sinks.push(
      new OtlpSink({
        endpoint: env.OTLP_ENDPOINT,
        headers: parseHeaders(env.OTLP_HEADERS),
        waitUntil,
      }),
    );
  }

  return sinks.length === 1 ? sinks[0]! : new MultiSink(sinks);
}

export interface TracerFactoryOptions extends BuildSinkOptions {
  serviceName: string;
  instanceId?: string | null;
  attributes?: Attributes;
}

/** Tracer continuing the caller's trace, for an inbound HTTP request. */
export function tracerForRequest(request: Request, options: TracerFactoryOptions): Tracer {
  return Tracer.fromRequest(request, {
    serviceName: options.serviceName,
    instanceId: options.instanceId,
    attributes: options.attributes,
    sink: buildSink(options),
  });
}

/**
 * Tracer for work with no inbound request — a queue consumer, a cron sweep, a
 * Durable Object alarm.
 *
 * Pass `traceId` to keep queued work attached to the request that enqueued it;
 * otherwise the job would start a disconnected trace and you'd lose the link
 * between "user asked" and "worker did it an hour later".
 */
export function tracerForJob(
  options: TracerFactoryOptions & { traceId?: string | null },
): Tracer {
  return new Tracer({
    serviceName: options.serviceName,
    instanceId: options.instanceId,
    attributes: options.attributes,
    sink: buildSink(options),
    ...(options.traceId
      ? { context: { traceId: options.traceId, spanId: newSpanId(), sampled: true } }
      : {}),
  });
}

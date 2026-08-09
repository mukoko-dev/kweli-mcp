// The telemetry D1 sink, against the real agent_events table.
//
// The sink's column order was previously only asserted against a hand-rolled
// fake, which would happily accept a statement real SQLite rejects. This
// executes it for real, so a column added to the migration but not the INSERT
// (or vice versa) fails here.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { D1Sink } from "@kweli-mcp/telemetry/src/sinks";
import { Tracer } from "@kweli-mcp/telemetry/src/tracer";
import type { TelemetryEvent } from "@kweli-mcp/telemetry/src/types";

const EVENT: TelemetryEvent = {
  timestamp: "2026-08-09T06:00:00.000Z",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: null,
  serviceName: "kweli-bulk-place-agent",
  instanceId: "task-42",
  severity: "info",
  name: "place.written",
  durationMs: 120,
  status: "ok",
  attributes: { placeId: "p1" },
};

/** Collects the sink's fire-and-forget writes so tests can await them. */
function sinkWithPending() {
  const pending: Promise<unknown>[] = [];
  const sink = new D1Sink({ db: env.DB, waitUntil: (p) => pending.push(p) });
  return { sink, settle: () => Promise.all(pending) };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM agent_events").run();
});

describe("D1Sink against real SQLite", () => {
  it("writes an event that reads back field for field", async () => {
    const { sink, settle } = sinkWithPending();
    sink.emit(EVENT);
    await settle();

    const row = await env.DB.prepare("SELECT * FROM agent_events").first<Record<string, unknown>>();

    expect(row).toMatchObject({
      timestamp: EVENT.timestamp,
      trace_id: EVENT.traceId,
      span_id: EVENT.spanId,
      service_name: EVENT.serviceName,
      instance_id: EVENT.instanceId,
      severity: "info",
      name: "place.written",
      duration_ms: 120,
      status: "ok",
    });
    expect(JSON.parse(row!.attributes_json as string)).toEqual({ placeId: "p1" });
  });

  it("stores a null parent span for a root span", async () => {
    const { sink, settle } = sinkWithPending();
    sink.emit(EVENT);
    await settle();

    const row = await env.DB.prepare("SELECT parent_span_id FROM agent_events").first<{
      parent_span_id: string | null;
    }>();
    expect(row!.parent_span_id).toBeNull();
  });

  it("stores null duration and status for a log record", async () => {
    // Log records aren't spans; the columns must accept NULL, which a
    // NOT NULL constraint added later would break.
    const { sink, settle } = sinkWithPending();
    sink.emit({ ...EVENT, durationMs: null, status: null });
    await settle();

    const row = await env.DB.prepare(
      "SELECT duration_ms, status FROM agent_events",
    ).first<{ duration_ms: number | null; status: string | null }>();

    expect(row!.duration_ms).toBeNull();
    expect(row!.status).toBeNull();
  });

  it("is queryable per agent — the per-agent view", async () => {
    const { sink, settle } = sinkWithPending();
    sink.emit({ ...EVENT, serviceName: "kweli-bulk-place-agent" });
    sink.emit({ ...EVENT, serviceName: "kweli-single-place-agent" });
    sink.emit({ ...EVENT, serviceName: "kweli-mcp" });
    await settle();

    const { results } = await env.DB.prepare(
      "SELECT name FROM agent_events WHERE service_name = ?",
    )
      .bind("kweli-single-place-agent")
      .all();

    expect(results).toHaveLength(1);
  });

  it("is queryable per trace across services — the reason it's one table", async () => {
    // Table-per-agent would make this a UNION that grows with every agent.
    const { sink, settle } = sinkWithPending();
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    sink.emit({ ...EVENT, traceId, serviceName: "kweli-mcp", name: "tool.request_place" });
    sink.emit({ ...EVENT, traceId, serviceName: "kweli-single-place-agent", name: "submit" });
    sink.emit({ ...EVENT, traceId, serviceName: "kweli-single-place-agent", name: "mongo.write" });
    sink.emit({ ...EVENT, traceId: "b".repeat(32), serviceName: "kweli-mcp", name: "unrelated" });
    await settle();

    const { results } = await env.DB.prepare(
      "SELECT service_name, name FROM agent_events WHERE trace_id = ? ORDER BY name",
    )
      .bind(traceId)
      .all<{ service_name: string; name: string }>();

    expect(results.map((r) => r.name)).toEqual(["mongo.write", "submit", "tool.request_place"]);
    expect(new Set(results.map((r) => r.service_name)).size).toBe(2);
  });

  it("joins a task to the spans that produced it", async () => {
    // tasks.trace_id ↔ agent_events.trace_id — what migration 0003 exists for.
    const traceId = "cccccccccccccccccccccccccccccccc";
    await env.DB.prepare(
      `INSERT INTO tasks (task_id, task_type, status, priority, region_json,
         categories_json, task_json, created_at, trace_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
      .bind("task-join", "seed_region", "done", 1, "{}", "[]", "{}", EVENT.timestamp, traceId)
      .run();

    const { sink, settle } = sinkWithPending();
    sink.emit({ ...EVENT, traceId, name: "task.done" });
    await settle();

    const row = await env.DB.prepare(
      `SELECT e.name FROM agent_events e
         JOIN tasks t ON t.trace_id = e.trace_id
        WHERE t.task_id = ?`,
    )
      .bind("task-join")
      .first<{ name: string }>();

    expect(row!.name).toBe("task.done");
  });

  it("carries a whole span tree written through a Tracer", async () => {
    const { sink, settle } = sinkWithPending();
    const tracer = new Tracer({
      serviceName: "kweli-bulk-place-agent",
      instanceId: "task-tree",
      sink,
    });

    await tracer.span("outer", async (outer) => {
      await outer.span("inner", async () => undefined);
    });
    await settle();

    const { results } = await env.DB.prepare(
      "SELECT name, span_id, parent_span_id FROM agent_events ORDER BY name",
    ).all<{ name: string; span_id: string; parent_span_id: string | null }>();

    const inner = results.find((r) => r.name === "inner")!;
    const outer = results.find((r) => r.name === "outer")!;
    expect(inner.parent_span_id).toBe(outer.span_id);
  });
});

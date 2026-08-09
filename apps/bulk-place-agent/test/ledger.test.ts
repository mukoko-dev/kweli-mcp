// The D1 task ledger, against a real D1 in real workerd.
//
// Every one of these was previously unverified — the ledger is the queryable
// record across all ingestion tasks, and nothing had ever executed a single
// statement against a real database.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Imported from the modules directly, NOT the package barrel: the barrel
// re-exports the provider registry, which pulls in the mongodb driver, and
// mongodb requires `node:process` in a way workerd cannot resolve. Nothing
// here needs Mongo — only D1.
import {
  findPendingByDedup,
  getTaskStatus,
  insertTask,
  listRequeuable,
  markProcessing,
  markResult,
  markStatus,
} from "@kweli-mcp/shared/src/ledger";
import type { SeedTask } from "@kweli-mcp/shared/src/types";

function seedTask(overrides: Partial<SeedTask> = {}): SeedTask {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    taskType: "seed_region",
    region: { kind: "bbox", s: -18, w: 30, n: -17, e: 31 },
    categories: "all",
    source: { kind: "ops_mcp" },
    status: "queued",
    priority: 1,
    dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as SeedTask;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tasks").run();
});

describe("migrations", () => {
  it("produce a tasks table carrying every column the ledger writes", async () => {
    // 0003's `ALTER TABLE tasks ADD COLUMN trace_id` had never been applied
    // anywhere before this test existed.
    const { results } = await env.DB.prepare("PRAGMA table_info(tasks)").all<{ name: string }>();
    const columns = results.map((r) => r.name);

    for (const column of [
      "task_id",
      "task_type",
      "status",
      "priority",
      "dedup_key",
      "region_json",
      "categories_json",
      "task_json",
      "created_at",
      "records", // added by 0002
      "trace_id", // added by 0003
    ]) {
      expect(columns).toContain(column);
    }
  });

  it("produce the agent_events telemetry table", async () => {
    const { results } = await env.DB.prepare(
      "PRAGMA table_info(agent_events)",
    ).all<{ name: string }>();
    const columns = results.map((r) => r.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "timestamp",
        "trace_id",
        "span_id",
        "parent_span_id",
        "service_name",
        "instance_id",
        "severity",
        "name",
        "duration_ms",
        "status",
        "attributes_json",
      ]),
    );
  });
});

describe("insertTask + getTaskStatus", () => {
  it("round-trips a task through real SQL", async () => {
    const task = seedTask();
    await insertTask(env, task);

    const row = await getTaskStatus(env, task.taskId);
    expect(row).toMatchObject({ taskId: task.taskId, status: "queued" });
    expect(row!.records).toEqual([]);
  });

  it("returns null for a task that does not exist", async () => {
    expect(await getTaskStatus(env, "nope")).toBeNull();
  });

  it("persists the trace id so a task joins to its telemetry", async () => {
    // The whole point of 0003: tasks.trace_id = agent_events.trace_id.
    const task = seedTask({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
    await insertTask(env, task);

    const { results } = await env.DB.prepare(
      "SELECT trace_id FROM tasks WHERE task_id = ?",
    )
      .bind(task.taskId)
      .all<{ trace_id: string }>();

    expect(results[0]!.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("stores a null trace id rather than failing when there is none", async () => {
    const task = seedTask();
    await expect(insertTask(env, task)).resolves.toBeUndefined();
  });
});

describe("dedup", () => {
  it("finds an in-flight task by dedup key", async () => {
    const task = seedTask({ dedupKey: "zw:harare:all" });
    await insertTask(env, task);
    expect(await findPendingByDedup(env, "zw:harare:all")).toBe(task.taskId);
  });

  it("stops matching once the task finishes", async () => {
    // Dedup covers work in flight, not work already done — otherwise a
    // region could never be re-seeded.
    const task = seedTask({ dedupKey: "zw:bulawayo:all" });
    await insertTask(env, task);
    await markResult(env, task.taskId, "done", {
      placesCreated: 1,
      entitiesCreated: 1,
      skipped: 0,
      notes: null,
      records: [],
    });

    expect(await findPendingByDedup(env, "zw:bulawayo:all")).toBeNull();
  });

  it("still matches while processing", async () => {
    const task = seedTask({ dedupKey: "zw:mutare:all" });
    await insertTask(env, task);
    await markProcessing(env, task.taskId);
    expect(await findPendingByDedup(env, "zw:mutare:all")).toBe(task.taskId);
  });
});

describe("status transitions", () => {
  it("markProcessing sets started_at once and does not overwrite it", async () => {
    const task = seedTask();
    await insertTask(env, task);

    await markProcessing(env, task.taskId);
    const first = (await getTaskStatus(env, task.taskId))!.startedAt;

    await markProcessing(env, task.taskId); // a retry
    const second = (await getTaskStatus(env, task.taskId))!.startedAt;

    // COALESCE keeps the original — the first attempt is when work began.
    expect(second).toBe(first);
  });

  it("markResult records counts, notes and created records", async () => {
    const task = seedTask();
    await insertTask(env, task);

    await markResult(env, task.taskId, "done", {
      placesCreated: 3,
      entitiesCreated: 2,
      skipped: 1,
      notes: "one tile empty",
      records: [
        {
          placeId: "p1",
          entityId: "e1",
          osmId: "node/1",
          name: "Somewhere",
          placeCreated: true,
          entityCreated: true,
        },
      ],
    });

    const row = (await getTaskStatus(env, task.taskId))!;
    expect(row).toMatchObject({
      status: "done",
      placesCreated: 3,
      entitiesCreated: 2,
      skipped: 1,
      notes: "one tile empty",
    });
    expect(row.records).toHaveLength(1);
    expect(row.records[0]).toMatchObject({ placeId: "p1", osmId: "node/1" });
    expect(row.finishedAt).toBeTruthy();
  });

  it("markResult tolerates a null result on failure", async () => {
    const task = seedTask();
    await insertTask(env, task);
    await markResult(env, task.taskId, "failed", null, "Overpass timed out");

    const row = (await getTaskStatus(env, task.taskId))!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Overpass timed out");
    expect(row.records).toEqual([]);
  });

  it("markStatus can return a task to the queue with its error retained", async () => {
    const task = seedTask();
    await insertTask(env, task);
    await markStatus(env, task.taskId, "queued", "attempt 1 failed");

    const row = (await getTaskStatus(env, task.taskId))!;
    expect(row.status).toBe("queued");
    expect(row.error).toBe("attempt 1 failed");
  });
});

describe("listRequeuable", () => {
  it("returns only failed and partial tasks, as full envelopes", async () => {
    const done = seedTask();
    const failed = seedTask();
    const partial = seedTask();
    const queued = seedTask();

    for (const t of [done, failed, partial, queued]) await insertTask(env, t);
    await markResult(env, done.taskId, "done", null);
    await markStatus(env, failed.taskId, "failed", "boom");
    await markStatus(env, partial.taskId, "partial");

    const requeuable = await listRequeuable(env, 50);
    const ids = requeuable.map((t) => t.taskId);

    expect(ids).toContain(failed.taskId);
    expect(ids).toContain(partial.taskId);
    expect(ids).not.toContain(done.taskId);
    // A queued task is already on the queue — re-sending would duplicate it.
    expect(ids).not.toContain(queued.taskId);

    // The stored envelope must survive round-tripping, since the sweeper
    // re-sends it to the queue verbatim.
    expect(requeuable[0]!.taskType).toBe("seed_region");
    expect(requeuable[0]!.region).toBeTruthy();
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) {
      const t = seedTask();
      await insertTask(env, t);
      await markStatus(env, t.taskId, "failed", "boom");
    }
    expect(await listRequeuable(env, 2)).toHaveLength(2);
  });
});

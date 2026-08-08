# Migration status: fundi-ingestion → kweli-mcp

`nyuchi/kweli`'s `workers/fundi-ingestion/` is the origin of the code in
`apps/bulk-ingestion-agent/` and `apps/mcp-ingestion/` in this repo. Per the
agreed migration mode ("copy now, remove from kweli later"):

- **Done in this PR:** the working logic (agent.ts, agent-do.ts, mcp.ts,
  enqueue.ts, the OAuth/M2M plumbing, all `skills/*`, the D1 ledger, the
  boundary guard, Plus Codes, bulk-intent generators) is copied here,
  redistributed across `apps/bulk-ingestion-agent`, `apps/mcp-ingestion`, and
  the shared `packages/{mongo,shared,skills}`, with the single worker split
  into two (MCP-facing vs. executor) that share the `fundi-ingestion-tasks`
  queue and the `fundi-ingestion-ledger` D1 database by resource id — plus one
  new real `[[services]]` binding (`mcp-ingestion` → `bulk-ingestion-agent`,
  `/internal/force-run`) that didn't exist in the single-worker version.
- **NOT done yet:** `nyuchi/kweli`'s `workers/fundi-ingestion/` directory
  still exists and is still the deployed, production `fundi-ingestion.nyuchi.dev`
  worker. `lib/services/fundi.service.ts` (kweli's own admin sync) and
  nhimbe's `src/app/actions/geocode.ts` `reportSearchMiss()` still point at
  it. **Do not delete `workers/fundi-ingestion/` from `nyuchi/kweli` until:**
  1. `apps/bulk-ingestion-agent` and `apps/mcp-ingestion` are deployed here
     and verified against a real task end-to-end (submit → queue → DO →
     Mongo write → D1 status).
  2. The D1 database (`fundi-ingestion-ledger`, id
     `1ca0ed44-20fc-4cd5-a6c1-86b40daf1041`) and KV namespace
     (`fundi-ingestion-tasks` dedup, id `7e726479ef2048c5b12e51bf1cc25141`)
     are re-pointed or migrated — this repo's wrangler configs reuse the
     *same* resource ids on the assumption the old worker is retired, not
     running in parallel against the same D1/queue.
  3. `kweli`'s `lib/services/fundi.service.ts` and nhimbe's
     `reportSearchMiss()` are repointed at the new `fundi-bulk.nyuchi.dev` /
     `fundi-ingestion.nyuchi.dev` split (whichever domain ends up owning
     `POST /tasks` — currently `apps/mcp-ingestion`).
  4. A follow-up PR on `nyuchi/kweli` deletes `workers/fundi-ingestion/` and
     updates its `CLAUDE.md`.

Until step 4, treat `nyuchi/kweli`'s copy as the live source of truth and
this repo's copy as staged, not yet serving production traffic.

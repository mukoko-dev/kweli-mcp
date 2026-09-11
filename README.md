# Kweli MCP

> Mukoko Kweli's agentic surface — one MCP server and three place-generation
> agents, as a Turborepo of Cloudflare Workers.

[![CI](https://github.com/mukoko-dev/kweli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mukoko-dev/kweli-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-2-EF4444?style=flat-square&logo=turborepo&logoColor=white)
![WorkOS](https://img.shields.io/badge/Auth-WorkOS-6363F1?style=flat-square&logo=workos&logoColor=white)

**Node:** 22 | **Package manager:** pnpm 10.15 | **Target endpoint:**
`kweli.mukoko.com/mcp` | **Platform:**
[kweli.mukoko.com](https://kweli.mukoko.com)

---

## Status: not yet deployed

None of these Workers is live. `fundi-bulk.nyuchi.dev`,
`fundi-place.nyuchi.dev` and `kweli-review.nyuchi.dev` have no DNS records,
and `kweli.mukoko.com/mcp` is still answered by the Next.js route in
[`mukoko-dev/kweli`](https://github.com/mukoko-dev/kweli). The production
ingestion worker is still that repo's `workers/fundi-ingestion`, deployed at
`fundi-ingestion.nyuchi.dev`.

[`MIGRATION.md`](./MIGRATION.md) is the cutover checklist and lists what is
blocking — chiefly that a human must mint each M2M application's client secret
in the WorkOS dashboard, and that the D1 database and KV namespace ids here are
the _same_ ones the old worker is using, so both cannot run at once.

---

## What it is

`mukoko-dev/kweli`'s `workers/fundi-ingestion` was one Worker doing four jobs.
This repo splits it into four Workers that deploy independently, over five
shared packages.

The split is deliberate rather than cosmetic: **the agents are not MCP-only.**
`bulk-place-agent` and `single-place-agent` each own a public `POST /tasks`
authenticated with a WorkOS M2M `client_credentials` token, so any
Nyuchi or Mukoko app can call them directly. The MCP holds its own copy of each
agent's client id and secret and calls the same public endpoint over a service
binding — there is no internal-trust bypass.

### Apps

| App                              | Worker                            | Custom domain             | What it does                                                                    |
| -------------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `apps/mcp`                       | `kweli-mcp`                       | `kweli.mukoko.com/mcp*`   | The Kweli MCP — graph reads, verification, place generation. WorkOS OAuth-gated |
| `apps/bulk-place-agent`          | `kweli-bulk-place-agent`          | `fundi-bulk.nyuchi.dev`   | Region and country seeding from Overpass/OSM. Queue-driven, org-restricted      |
| `apps/single-place-agent`        | `kweli-single-place-agent`        | `fundi-place.nyuchi.dev`  | One named place, created synchronously                                          |
| `apps/verification-review-agent` | `kweli-verification-review-agent` | `kweli-review.nyuchi.dev` | **Stub.** Assists human review of ownership claims; never writes a tier         |

Each agent is a Cloudflare Agent — a SQLite-backed Durable Object, one instance
per task.

### Packages

| Package                 | What it holds                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@kweli-mcp/mongo`      | Shared Mongo client and the verification-tier ladder                                                                              |
| `@kweli-mcp/shared`     | Ingestion task, region and ledger domain code; the Africa boundary guard; UUIDv7; Plus Codes                                      |
| `@kweli-mcp/skills`     | Overpass lookup, OSM classification, AI descriptions, Nominatim hierarchy, tile maths, What3Words, Wikidata, the Mongo write step |
| `@kweli-mcp/telemetry`  | W3C traceparent, spans, structured logs; stdout / D1 / OTLP sinks. Zero dependencies                                              |
| `@kweli-mcp/workos-m2m` | WorkOS `client_credentials` — `verify.ts` for agents, `mint.ts` for callers                                                       |

`@kweli-mcp/mongo` mirrors `kweli`'s own `lib/mongodb/client.ts` and
`lib/verification-tiers.ts`. **The two must never drift.**

---

## The MCP tools

Fifteen, in three groups. Read tools are safe to call freely; generation tools
enqueue real work on the agents.

**Generation** — forwarded to an agent's public `POST /tasks`:

| Tool              | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `seed_region`     | Enqueue a bulk seed for a region. Returns a task id immediately |
| `seed_admin_bulk` | Fan one intent (e.g. every African capital) out into many tasks |
| `request_place`   | Create exactly one named place, not an area sweep               |

**Ingestion inspection** — the D1 ledger and Mongo:

| Tool                 | What it does                                                |
| -------------------- | ----------------------------------------------------------- |
| `task_status`        | Look a task up by id                                        |
| `task_records`       | Exactly what one task built, by logged id — deterministic   |
| `list_recent_places` | Tier-0 places Fundi created, newest or nearest first        |
| `compute_pluscode`   | Open Location Code from lat/lng, locally, no API            |
| `overpass_lookup`    | Query OSM/Overpass in a bounding box. Read-only             |
| `resolve_hierarchy`  | Reverse-geocode and preview the hierarchy a place would get |
| `list_geo_areas`     | Seeded administrative areas in `placesGeo`                  |

**Graph reads** — the public trust platform:

| Tool               | What it does                            |
| ------------------ | --------------------------------------- |
| `search_places`    | Search by name or city                  |
| `get_place`        | One place by id or slug                 |
| `get_organization` | An organization's public trust profile  |
| `get_verification` | The tier for a place or an organization |
| `get_open_stats`   | Open aggregates over the whole graph    |

Unlike `kweli`'s in-app `/mcp`, this server does not carry the deprecated
`search_venues` and `get_venue` aliases.

---

## Observability

Every Worker emits OpenTelemetry-shaped events through
[`@kweli-mcp/telemetry`](./packages/telemetry). One user action keeps a single
`trace_id` from the MCP tool call, across the service binding, into the agent,
through the queue and down to the Mongo write — so a place that never appeared
can be traced back to the request that asked for it.

| Sink              | When                        | Query it with           |
| ----------------- | --------------------------- | ----------------------- |
| JSON to stdout    | Always                      | Cloudflare Workers Logs |
| D1 `agent_events` | When a `DB` binding exists  | `wrangler d1 execute`   |
| OTLP/HTTP         | When `OTLP_ENDPOINT` is set | Your OTLP backend       |

```sql
-- What has one agent been doing?
SELECT * FROM agent_events WHERE service_name = 'kweli-single-place-agent'
  ORDER BY timestamp DESC LIMIT 50;

-- Everything that happened during one user action, across every service.
SELECT service_name, name, duration_ms, status FROM agent_events
  WHERE trace_id = '4bf92f...' ORDER BY timestamp;

-- A task and the spans that produced it.
SELECT e.* FROM agent_events e
  JOIN tasks t ON t.trace_id = e.trace_id WHERE t.task_id = ?;
```

---

## Commands

```bash
pnpm install
pnpm build          # turbo run build
pnpm test           # turbo run test
pnpm type-check     # turbo run type-check
pnpm lint           # turbo run lint

pnpm --filter kweli-bulk-place-agent dev      # per-app wrangler dev
pnpm --filter kweli-bulk-place-agent deploy
```

Each app deploys independently — `wrangler deploy` from its own directory, or
`pnpm --filter <name> deploy` from the root. Deploy `bulk-place-agent` and
`single-place-agent` before `mcp` on the first deploy, so the `[[services]]`
binding targets already exist.

CI runs `pnpm type-check`, `pnpm test` and `pnpm build` on Node 22 for every
push and pull request, plus the org lint gate. There is no deploy workflow;
deploys are manual.

`CLAUDE.md` carries the full architecture notes but is deliberately untracked,
so it will not be in your clone.

## Licence

Licensed under the [MIT Licence](LICENSE). © 2026 Nyuchi Web Services.

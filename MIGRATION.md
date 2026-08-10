# Migration status: fundi-ingestion → kweli-mcp

`nyuchi/kweli`'s `workers/fundi-ingestion/` is the origin of the code now
split across `apps/bulk-place-agent/` and `apps/mcp/` in this repo. Per the
agreed migration mode ("copy now, remove from kweli later"):

- **Done so far:** the working logic (agent.ts, agent-do.ts, mcp.ts,
  enqueue.ts, the OAuth/M2M plumbing, all `skills/*`, the D1 ledger, the
  boundary guard, Plus Codes, bulk-intent generators) is copied here,
  redistributed across `apps/bulk-place-agent`, `apps/mcp`, and the shared
  `packages/{mongo,shared,skills,workos-m2m}`. The original single fundi
  worker split into three, on a deliberate design: **the agents
  (`bulk-place-agent`, `single-place-agent`) are independent of the MCP** —
  each owns its own public `POST /tasks`, gated by a WorkOS M2M
  `client_credentials` token from its own dedicated application
  (`bulk-place-agent` additionally org-restricted via
  `WORKOS_ALLOWED_ORG_IDS`; `single-place-agent` is not). `apps/mcp` (the
  Kweli MCP, WorkOS OAuth-gated for interactive/agent clients) authenticates
  to both agents the exact same way any other Nyuchi/Mukoko app would — it
  mints its own M2M token per agent and calls `POST /tasks` over a
  `[[services]]` binding. There is no special internal-trust bypass.
- **NOT done yet:** `nyuchi/kweli`'s `workers/fundi-ingestion/` directory
  still exists and is still the deployed, production
  `fundi-ingestion.nyuchi.dev` worker. `lib/services/fundi.service.ts`
  (kweli's own admin sync) and nhimbe's `src/app/actions/geocode.ts`
  `reportSearchMiss()` still point at it. **Do not delete
  `workers/fundi-ingestion/` from `nyuchi/kweli` until:**
  1. `apps/bulk-place-agent`, `apps/single-place-agent`, and `apps/mcp` are
     deployed here and verified against a real task end-to-end (submit →
     queue → DO → Mongo write → D1 status), including a real WorkOS M2M
     round-trip (mint → verify) for each agent.
  2. ~~Two more WorkOS M2M applications are registered for real~~ **Done —
     see the app map below.** **Still outstanding:** a human must generate
     each M2M app's client secret in the WorkOS dashboard — that step is
     deliberately not exposed via the admin API/MCP surface — and set it as
     `BULK_M2M_CLIENT_SECRET` / `SINGLE_M2M_CLIENT_SECRET` on `apps/mcp` (and
     on any other app that calls these agents directly).
  3. The D1 database (`fundi-ingestion-ledger`, id
     `1ca0ed44-20fc-4cd5-a6c1-86b40daf1041`) and KV namespace
     (`fundi-ingestion-tasks` dedup, id `7e726479ef2048c5b12e51bf1cc25141`)
     are re-pointed or migrated — this repo's wrangler configs reuse the
     *same* resource ids on the assumption the old worker is retired, not
     running in parallel against the same D1/queue.
  4. `kweli`'s `lib/services/fundi.service.ts` and nhimbe's
     `reportSearchMiss()` are repointed at `bulk-place-agent`'s new
     `fundi-bulk.nyuchi.dev` domain, and switched from a static bearer token
     to minting a WorkOS M2M token (see `packages/workos-m2m/src/mint.ts`
     for the exact call shape).
  5. A follow-up PR on `nyuchi/kweli` deletes `workers/fundi-ingestion/` and
     updates its `CLAUDE.md`.

Until step 5, treat `nyuchi/kweli`'s copy as the live source of truth and
this repo's copy as staged, not yet serving production traffic.

## The WorkOS application map

Every app in this repo maps to exactly one WorkOS Connect application. All of
these are in the **Production** environment (`environment_01KQBBSMDHMT9Y5GVD8S1A3C0W`);
Staging currently has **zero** Connect apps, so a staging deploy fails closed on
the audience check until counterparts exist there.

| This repo | WorkOS app | client_id | Type | Org scope |
| --- | --- | --- | --- | --- |
| `apps/mcp` | **Kweli MCP** | `client_01KZPZYNSHSQEP2S6B0ZE9S9J0` | OAuth (confidential, Auth Code + PKCE) | none — any user may sign in |
| `bulk-place-agent` | **Kweli Fundi** | `client_01KZGMK14B53N6Z84GMJFW0ASC` | M2M | Nyuchi Africa (`org_01KRDAB894DJF5V38PT5617TV1`) |
| `verification-review-agent` | **Kweli Fundi** — *same app as bulk* | `client_01KZGMK14B53N6Z84GMJFW0ASC` | M2M | Nyuchi Africa |
| `single-place-agent` | **Kweli** | `client_01KZG8V8VVS6268W1ERMW7YBNE` | M2M | none enforced at the agent |

**Why the MCP is OAuth and the agents are M2M.** The MCP is where *people*
arrive, so it needs interactive sign-in and carries no org restriction. The
agents are machine surfaces with no user present, so they take
`client_credentials` only. Redirect URI registered for the MCP:
`https://kweli-mcp.nyuchi.dev/callback` (`redir_01KZPZZJRNGATDXZDSDZXQT212`).

**Why `verification-review-agent` shares "Kweli Fundi".** Bulk seeding and
claim review are run by the same team, so they authenticate as the same
principal. This is a deliberate exception to the one-app-per-agent rule, not
an oversight — the rule exists to stop *unrelated* surfaces sharing a
credential (see the fundi-tester trap), and it still forbids reusing either
M2M app for the MCP's interactive login. If review is ever operated by a
different team, it needs its own app at that point.

**Two client ids that must never be used here.** Both are live traps:

| Do not use | Why |
| --- | --- |
| `client_01KSJT4TC5GW6RHTKMHB3C9500` ("Nyuchi Fundi Tester") | `fundi-tester` is a **cyber security agent**, shared with `mzizi-mcp`. Nothing to do with places or Kweli. It was once wired into `bulk-place-agent` purely on the name matching |
| `client_01KV0ZZ4DK74YMEDYT22ARM1Y3` | The old `fundi-ingestion` `WORKOS_AGENTS_M2M_CLIENT_ID`. Exists in **neither** WorkOS environment — verified against the API — so anything pointing at it can never authenticate |

The live `fundi-ingestion` worker in `nyuchi/kweli` still carries that second
value, which means its `POST /tasks` M2M gate currently accepts no token at
all; only the static `FUNDI_API_TOKEN` path works. Repointing it at
`client_01KZGMK14B53N6Z84GMJFW0ASC` is part of step 4 above.

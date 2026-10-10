# Migration status: fundi-ingestion → kweli-mcp

## Architecture — owner decisions, 2026-10-10

These decisions supersede anything below that disagrees with them. The sections
further down are kept as the record of how the split was done; where they
conflict with this section, this section wins.

```
Apps · Claude · other clients
   │                                   │
   │ Cloudflare MCP portal             │ Cloudflare API Gateway
   ▼                                   ▼
MCP servers (Kweli MCP, …)        Agents (the Fundi agents, …)
   a person signs in                  WorkOS agent identity,
   read and write                     acting as an employee
   │                                   │
   └──────────────┬────────────────────┘
                  ▼
        Nyuchi API (api.nyuchi.com)   ← the only layer on the databases
                  ▼
           MongoDB · Postgres
```

1. **Agents are separate from MCP servers.** "Agents are treated separately
   from mcp." The Kweli MCP (`apps/mcp`) is an MCP server; the Fundi agents
   (`apps/bulk-place-agent`, `apps/single-place-agent`,
   `apps/verification-review-agent`) are agents. They are fronted
   separately: MCP servers through the **Cloudflare MCP portal**, agents
   through the **Cloudflare API Gateway**. Neither is exposed directly on its
   own hostname as the long-term shape.
2. **The Kweli MCP is read and write, with a person signing in.** "Kweli mcp
   is read and write, using a human to authenticate." The open graph reads
   stay anonymous (decision of 2026-10-07, `apps/mcp/src/public-gate.ts`);
   anything that writes needs a signed-in person through the **Kweli MCP**
   WorkOS app.
3. **Fundi agents act as employees, with WorkOS agent identity.** "fundi
   agents use agent with they act as employees … they use workos agent auth.
   With employee permissions." The flow is documented at
   `https://accounts.mukoko.com/agent/auth.md`: an agent registers an
   identity bound to an employee's email (`service_auth`), the employee
   approves the claim, and the agent exchanges its assertion
   (`urn:ietf:params:oauth:grant-type:jwt-bearer`) for short-lived access
   tokens carrying that employee's permissions. Agents verify those tokens
   and check the employee permission they need (for example `fundi:admin`).
   **This replaces the M2M `client_credentials` design below** — the "Kweli
   Fundi" and "Kweli" M2M apps and their client secrets are no longer on the
   cutover path.
4. **Fundi is a shared service, not a Kweli feature.** "fundi ingestion is
   the agent behind that seeds info into the right places … its role is to
   contribute and find things that are missing. It can be used by any repo
   or app." Callers must not have to change when Fundi moves: the address
   and request contract stay stable through the cutover.
5. **Fundi is not under the Nyuchi API.** "Fundi is not under the api. It's
   on top as we have multiple different fundi agents." A `/v1/fundi` proxy in
   the gateway was proposed and rejected (nyuchi/api-gateway#296, closed).
6. **No direct database access above the Nyuchi API.** "Nyuchi api sits on
   top of the [database] so no direct [db] access." The MCP and the agents
   read and write through `api.nyuchi.com`, not MongoDB. Today `apps/*`
   (and `fundi-ingestion`) still connect to MongoDB with `MONGODB_URI`; moving
   them onto the Nyuchi API is required work, and no worker here should be
   given `MONGODB_URI` for the cutover.
7. **The MCP asks Fundi through the Nyuchi API, and Redpanda carries the work.**
   Chosen option (a), refined: "the messaging request hits [Redpanda] a message
   board is created which the agent then picks up [a] single one or multiple
   at a time." When a signed-in person uses a Kweli MCP write tool that needs
   Fundi (for example "find the missing places here"), the MCP calls the
   Nyuchi API; the API publishes the request to Redpanda; the Fundi agents
   consume from that topic one message or a batch at a time. The MCP never
   calls an agent's `POST /tasks` directly and holds no agent credential.
   **This replaces the `[[services]]` binding + M2M call from `apps/mcp` to the
   agents described below.**

   What already exists in nyuchi/api-gateway (`docs/architecture/event-log.md`):
   the API publishes Avro envelopes to Redpanda with an idempotent producer
   over SASL/SCRAM; topics, ACLs and payload schemas live in
   nyuchi/data-infra; event types must be past-tense facts
   (`<domain>.<entity>.<verb>`, topic `<domain>.<entity>`), so the request is
   a fact such as `fundi.request.recorded` on `fundi.request`; the
   `nyuchi_events` consumer machinery reads in batches (up to 500), dedupes
   by `event_id`, and sends failures to `<topic>.dlq`.

   **Open — the bridge.** Redpanda listens only on Fly's private network
   (`*.internal:9092`, `SASL_PLAINTEXT`) and has no HTTP proxy, while the
   Fundi agents are Cloudflare Workers, so they cannot reach the board today.
   Redpanda authorisation is per SCRAM user and is not yet tied to WorkOS
   agent identity. The bridge must let an agent, authenticated as an employee
   (decision 3), take one or many requests and acknowledge them.

### Cutover status (2026-10-10)

- **Live:** `kweli.mukoko.com/mcp` is still the Next.js route in
  mukoko-dev/kweli. `kweli.mukoko.com` is proxied through Cloudflare; a zone
  WAF custom rule lets `*.mukoko.com/mcp` and `*.mukoko.com/mcp/*` skip Super
  Bot Fight Mode and the managed WAF rules (owner decision 2026-10-10), because
  MCP clients — Claude among them — are automated by design and were being
  served managed challenges.
- **Deployed privately, carrying no traffic:** `kweli-mcp`,
  `kweli-single-place-agent` and `kweli-bulk-place-agent` exist on
  `*.nyuchi.workers.dev` only — no zone routes, no custom domains. The bulk
  agent was deployed as a queue **producer only** (no consumer, no cron), so
  `fundi-ingestion` is still the sole consumer of `fundi-ingestion-tasks`.
  They have no `MONGODB_URI` (see decision 6) and so serve no data.
- **Fixed before cutover:** `apps/mcp` now has its own OAuth KV namespace,
  `kweli-mcp-OAUTH_KV`. It previously shared `fundi-OAUTH_KV` with
  `fundi-ingestion`, and `@cloudflare/workers-oauth-provider` accepts a token
  wherever its KV entry is found, so a Kweli sign-in (any user) would have
  passed fundi-ingestion's org-restricted gate.
- **Next, in order:**
  1. The Nyuchi API surface the MCP and agents need (reads already exist under
     `/v1/places`, `/v1/entities`, `/v1/verification`), the `fundi.request`
     topic and payload schema in nyuchi/data-infra, the API route that
     publishes it, and the bridge that lets the agents consume it
     (decision 7).
  2. Move `apps/*` from MongoDB onto that API.
  3. Agent identity in the agents (decision 3), replacing the M2M gate.
  4. Register the Kweli MCP in the Cloudflare MCP portal and the agents in the
     Cloudflare API Gateway (decision 1).
  5. Only then route `kweli.mukoko.com/mcp` to `apps/mcp`, and retire
     `fundi-ingestion` with its address and contract kept stable (decision 4).

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
  2. _(Superseded by decision 3: agents use WorkOS agent identity, not M2M.)_
     ~~Two more WorkOS M2M applications are registered for real~~ **Done —
     see the app map below.** **Still outstanding:** a human must generate
     each M2M app's client secret in the WorkOS dashboard — that step is
     deliberately not exposed via the admin API/MCP surface — and set it as
     `BULK_M2M_CLIENT_SECRET` / `SINGLE_M2M_CLIENT_SECRET` on `apps/mcp` (and
     on any other app that calls these agents directly).
  3. The D1 database (`fundi-ingestion-ledger`, id
     `1ca0ed44-20fc-4cd5-a6c1-86b40daf1041`) and KV namespace
     (`fundi-ingestion-tasks` dedup, id `7e726479ef2048c5b12e51bf1cc25141`)
     are re-pointed or migrated — this repo's wrangler configs reuse the
     _same_ resource ids on the assumption the old worker is retired, not
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

> **Superseded in part (decision 3, 2026-10-10):** the agents authenticate with WorkOS
> agent identity acting as employees. The two M2M apps below are no longer on the
> cutover path; the **Kweli MCP** OAuth app (people signing in) still is.

Every app in this repo maps to exactly one WorkOS Connect application. All of
these are in the **Production** environment (`environment_01KQBBSMDHMT9Y5GVD8S1A3C0W`);
Staging currently has **zero** Connect apps, so a staging deploy fails closed on
the audience check until counterparts exist there.

| This repo                   | WorkOS app                           | client_id                           | Type                                   | Org scope                                        |
| --------------------------- | ------------------------------------ | ----------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `apps/mcp`                  | **Kweli MCP**                        | `client_01KZPZYNSHSQEP2S6B0ZE9S9J0` | OAuth (confidential, Auth Code + PKCE) | none — any user may sign in                      |
| `bulk-place-agent`          | **Kweli Fundi**                      | `client_01KZGMK14B53N6Z84GMJFW0ASC` | M2M                                    | Nyuchi Africa (`org_01KRDAB894DJF5V38PT5617TV1`) |
| `verification-review-agent` | **Kweli Fundi** — _same app as bulk_ | `client_01KZGMK14B53N6Z84GMJFW0ASC` | M2M                                    | Nyuchi Africa                                    |
| `single-place-agent`        | **Kweli**                            | `client_01KZG8V8VVS6268W1ERMW7YBNE` | M2M                                    | none enforced at the agent                       |

**Why the MCP is OAuth and the agents are M2M.** The MCP is where _people_
arrive, so it needs interactive sign-in and carries no org restriction. The
agents are machine surfaces with no user present, so they take
`client_credentials` only. Redirect URI registered for the MCP:
`https://kweli.mukoko.com/mcp/callback` (`redir_01KZQ0CACCADT6JJD294YGCWFV`).

## Serving from kweli.mukoko.com/mcp

The Kweli MCP is a **consumer** surface, so it belongs on the consumer domain:
`https://kweli.mukoko.com/mcp`. It is deliberately **not** on `nyuchi.dev` —
that hostname carries internal tooling only. The endpoint used to be planned as
`kweli-mcp.nyuchi.dev`; every reference to that is now wrong.

**Done in code.** The worker no longer assumes it owns a hostname. Its mount
point is an environment variable (`MCP_BASE_PATH`, default `/mcp` — see
`apps/mcp/src/paths.ts`), every route is mounted under it, and the WorkOS
redirect URI and approval-dialog logo are built from it. `wrangler.jsonc`
declares the zone route `kweli.mukoko.com/mcp*` instead of a custom domain, so
one hostname can be shared with the Kweli Next.js app.
`apps/mcp/test/mount.test.ts` pins the behaviour that matters: the worker
answers `/mcp/*` and **404s at the origin root**.

Two details that are load-bearing rather than cosmetic:

- `apiRoute` is matched by **prefix** inside `@cloudflare/workers-oauth-provider`,
  so with the MCP endpoint at `/mcp` every sibling path shares that prefix and
  would be swallowed by the token-gated handler (a 401, not a 404).
  `apps/mcp/src/index.ts` dispatches `/mcp/authorize`, `/mcp/callback` and
  `/mcp/health` to the default handler itself, before the provider can claim
  them. The token and registration endpoints are exact-matched by the provider
  ahead of the prefix check, so those stay with it.
- The redirect URI **must** stay mount-relative. `https://kweli.mukoko.com/callback`
  is a real route belonging to the Kweli web app's own AuthKit client, so an
  origin-relative redirect would deliver this MCP's authorization code to a
  different OAuth client and answer 200 while doing it — a silent
  cross-wiring, not an error.

**Decided 2026-10-07: split by tool (option 2 below).** The owner's call:
the graph reads stay anonymous under the open-data policy, and sign-in is
asked for only for generation and internal tools. Done in code
(`apps/mcp/src/public-gate.ts`): a request with no token is served
anonymously; calling a gated tool without one answers 401 with an RFC 9728
`resource_metadata` pointer, so the client signs in and retries. The open set
is an allowlist (`PUBLIC_TOOLS`); `search_venues` / `get_venue` stay callable as
aliases; the anonymous door is limited to 60 calls a minute per IP, as the
Next.js route was. Discovery is fixed in the same change: the worker serves
its own protected-resource and authorization-server metadata at the
path-suffixed `.well-known/*/mcp` URLs, naming `https://kweli.mukoko.com/mcp`
as the issuer, and `wrangler.jsonc` routes those paths here. Deploying the
routes retires the Next.js route; the remaining blockers are the M2M secrets
and the shared D1/KV below.

The decision as it was framed:
`kweli.mukoko.com/mcp` is already live: `nyuchi/kweli`'s `app/mcp/route.ts`
serves an **anonymous, read-only** MCP (`search_places`, `get_place`,
`get_organization`, `get_verification`, `get_open_stats`, plus the legacy
`search_venues` / `get_venue` aliases), rate-limited per IP, advertised by
`/.well-known/mcp/server-card.json` with `authentication: none` under Mukoko's
open-data policy. Adding the zone route retires that surface, because a zone
route wins over the Next.js app for the whole `/mcp*` prefix. The worker is a
superset in tools but **not** in access: it gates everything behind WorkOS
sign-in, so every existing anonymous client breaks at the moment of cutover.
Pick one before routing:

1. **Gate everything** — accept that the open-data MCP becomes
   authenticated, update the server card, and announce the break.
2. **Split by tool** — keep the read tools anonymous in the worker and require
   OAuth only for ingestion/generation. This is work in `apps/mcp`: the OAuth
   provider currently gates the whole endpoint, so the read tools would need to
   be served ahead of it.
3. **Keep both** — leave the anonymous reads on the Next.js route and mount the
   authenticated worker on a different prefix (`MCP_BASE_PATH` exists for
   exactly this). Costs the clean `/mcp` URL.

Whichever is chosen, discovery needs fixing in the same change:
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource` on `kweli.mukoko.com` are served by the
Kweli app and point at the **WorkOS** issuer. For the worker, WorkOS is only
the upstream identity provider — the worker is itself the authorization server
for MCP clients (it issues its own tokens and offers DCR at `/mcp/register`).
A client that follows the current metadata gets a WorkOS token, presents it to
`/mcp`, and is rejected. The worker's own metadata lives at the origin root,
which the `/mcp*` route never receives, so `kweli` must serve
`/.well-known/oauth-protected-resource/mcp` pointing at the worker's
authorization-server metadata (RFC 9728 §3.1 path-suffixed form).

**Why `verification-review-agent` shares "Kweli Fundi".** Bulk seeding and
claim review are run by the same team, so they authenticate as the same
principal. This is a deliberate exception to the one-app-per-agent rule, not
an oversight — the rule exists to stop _unrelated_ surfaces sharing a
credential (see the fundi-tester trap), and it still forbids reusing either
M2M app for the MCP's interactive login. If review is ever operated by a
different team, it needs its own app at that point.

**Two client ids that must never be used here.** Both are live traps:

| Do not use                                                  | Why                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_01KSJT4TC5GW6RHTKMHB3C9500` ("Nyuchi Fundi Tester") | `fundi-tester` is a **cyber security agent**, shared with `mzizi-mcp`. Nothing to do with places or Kweli. It was once wired into `bulk-place-agent` purely on the name matching |
| `client_01KV0ZZ4DK74YMEDYT22ARM1Y3`                         | The old `fundi-ingestion` `WORKOS_AGENTS_M2M_CLIENT_ID`. Exists in **neither** WorkOS environment — verified against the API — so anything pointing at it can never authenticate |

The live `fundi-ingestion` worker in `nyuchi/kweli` still carries that second
value, which means its `POST /tasks` M2M gate currently accepts no token at
all; only the static `FUNDI_API_TOKEN` path works. Repointing it at
`client_01KZGMK14B53N6Z84GMJFW0ASC` is part of step 4 above.

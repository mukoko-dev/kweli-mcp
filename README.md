# kweli-mcp

Mukoko Kweli's agentic surface — one Kweli MCP plus two independent place
generation agents, as a turborepo of Cloudflare Workers, bound together with
real [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
where that's genuinely the right tool, and plain WorkOS-M2M-authenticated
HTTP everywhere the agents need to be callable by other apps.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and
[`MIGRATION.md`](./MIGRATION.md) for the fundi-ingestion move status.

## Layout

```
apps/
  mcp/                         The Kweli MCP — graph reads, verification,
                                and place generation, WorkOS OAuth-gated
  bulk-place-agent/            Bulk region/country seeding (working) — own
                                public POST /tasks, WorkOS M2M + org check
  single-place-agent/          Single named-place creation (working,
                                synchronous) — own public POST /tasks,
                                WorkOS M2M, no org check
  verification-review-agent/   Claim-review assistant (STUB)
packages/
  mongo/                       Shared Mongo client + verification-tier ladder
  shared/                      Ingestion task/region/ledger domain code
  skills/                      Overpass/classify/description/Nominatim/etc.
  workos-m2m/                  WorkOS client_credentials — verify (agent
                                side) and mint (caller side)
```

## The agents are not MCP-only

`bulk-place-agent` and `single-place-agent` each have their own public
`POST /tasks`, authenticated with a **WorkOS M2M `client_credentials`**
token. Any Nyuchi/Mukoko app can call either directly — the Kweli MCP is
just one more caller, holding its own copy of each agent's client_id/secret
like everyone else. See each agent's `.dev.vars.example` for the exact
request shape.

## Commands

```bash
pnpm install
pnpm build          # turbo run build
pnpm test           # turbo run test
pnpm type-check      # turbo run type-check
pnpm --filter kweli-bulk-place-agent dev    # per-app wrangler dev
pnpm --filter kweli-bulk-place-agent deploy
```

Each app deploys independently (`wrangler deploy` from its own directory, or
`pnpm --filter <name> deploy` from the root). Deploy `bulk-place-agent` and
`single-place-agent` before `mcp` on first deploy, so their `[[services]]`
binding targets already exist.

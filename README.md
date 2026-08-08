# kweli-mcp

Mukoko Kweli's agentic surface — MCP servers and ingestion agents, as a
turborepo of Cloudflare Workers, bound together with real
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
rather than public HTTP calls where the two sides are both ours.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and
[`MIGRATION.md`](./MIGRATION.md) for the fundi-ingestion move status.

## Layout

```
apps/
  mcp-places/                 Public read-only graph MCP (+ request_place)
  mcp-ingestion/              OAuth-gated bulk-ingestion MCP + /tasks submit
  bulk-ingestion-agent/       FundiAgent — the bulk-seeding executor (working)
  single-place-agent/         Single named-place creation (STUB)
  verification-review-agent/  Claim-review assistant (STUB)
packages/
  mongo/                      Shared Mongo client + verification-tier ladder
  shared/                     Ingestion task/region/ledger domain code
  skills/                     Overpass/classify/description/Nominatim/etc.
```

## Commands

```bash
pnpm install
pnpm build          # turbo run build
pnpm test           # turbo run test
pnpm type-check      # turbo run type-check
pnpm --filter kweli-bulk-ingestion-agent dev    # per-app wrangler dev
pnpm --filter kweli-bulk-ingestion-agent deploy
```

Each app deploys independently (`wrangler deploy` from its own directory, or
`pnpm --filter <name> deploy` from the root). There is no single "deploy
everything" step — bind order matters: deploy `bulk-ingestion-agent` and
`single-place-agent` before `mcp-ingestion` / `mcp-places` the first time, so
their `[[services]]` binding targets already exist.

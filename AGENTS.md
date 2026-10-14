# AGENTS.md — kweli-mcp

The org rules (`nyuchi/.github` `AGENTS.md`) apply: big work gets a GitHub
issue, load the Mzizi dev skills (`digital-hygiene`, `progress-report`) before
starting, and merge only when CI is green, the change is verified at runtime
and `/code-review` has run with findings resolved. This file adds the stack.

## What this is

Mukoko Kweli's agentic surface: one MCP server and three place-generation
agents, as a Turborepo of Cloudflare Workers (see `README.md`). There is no UI
in this repo.

## Stack and release flow

Owner decision, 2026-10-14: every repo follows one stack.

- **UI is pure Astro.** Pages are `.astro` shells built from `@bundu/ui`
  (`@bundu/ui/app/*`, `@bundu/ui/discover/*`). No third UI framework, and no
  client JavaScript unless the component's contract allows one enhancement
  script. A missing or changed component is fixed upstream in
  `mzizi-dev/mzizi-registry` (contract, `.astro` and `.tsx` together); do not
  fork or restyle it here.
- **Servers and backends are Rust only.** The Rust fills the Astro shells and
  holds the data and the rules. The server components are crates, not npm
  packages: shared logic comes from the `mzizi-*` crates on crates.io (all
  0.3.0, published 2026-10-07): `mzizi-roots`,
  `mzizi-roots-server`, `mzizi-tokens`, `mzizi-ui`, `mzizi-shell`,
  `mzizi-brand`, and the server cores `mzizi-assurance`, `mzizi-discovery`,
  `mzizi-docs`, `mzizi-fundi` and `mzizi-activitypub`. Pin versions.
- **Release flow.** Branch from `staging`, open every PR against `staging`,
  and promote `staging` to `main` with a release PR. Nothing goes to `main`
  directly.
- **Big moves need an issue first.** A rewrite (a framework or a language)
  gets a tracking issue that names the entity it belongs to, what it
  replaces and the metric it moves, before any code.

- **Mzizi limits today.** `@bundu/ui` 0.6.0 was not on npm when this was
  written (0.5.0 was the latest on 2026-10-07). Only seven primitives have
  Rust and React builds; the shells and page patterns are Astro only. The
  `workers-rs` adapter crate (`mzizi-worker`) has not landed, so a Worker
  writes its own few lines of adapter. Check before relying on any of these.

Where this repo stands today:

- **Built:** TypeScript Workers (`apps/mcp`, `apps/bulk-place-agent` and the
  other agents), with `pnpm` and Turborepo. Nothing here is Rust yet, and
  the production cut-over is still pending (see `MIGRATION.md`; `beta.yml`
  publishes a staging preview).
- **Direction:** all of it is Rust, the MCP server included. The Mzizi
  `mzizi-backend` skill still describes a TypeScript host for MCP servers
  (the MCP SDK and `agents` are TypeScript-first); this repo follows the
  owner's rule instead. The shape is a sans-IO core with a thin `worker`
  (workers-rs) host. `rmcp` (the Rust MCP SDK on crates.io, 3.5.1) is a
  candidate for the MCP layer; whether it builds for the Workers wasm target
  has not been checked, so the tracking issue must settle that first.
- Do not port a working Worker without a tracking issue. When one is ported,
  its existing tests are the contract the port must meet.

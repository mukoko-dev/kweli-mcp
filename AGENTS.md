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
- **One business backend: `mukoko-business-backend`.** Verify and Kweli are UIs
  on top of one new Rust Worker, `mukoko-business-backend` (not built yet).
  A UI never calls the api-gateway (`api.nyuchi.com`) directly: it calls the
  backend with a short-lived token. The backend verifies WorkOS, and it sits
  on top of the api-gateway. Verify and Kweli can run on Vercel; the MCP server
  is the only one of the three that is a Worker. This MCP server uses the same backend; as a Worker it can reach it by service
  binding, which has not been decided. No backend has
  direct database access: no database driver, no connection string, no database
  binding. Neither UI should keep a data store or business rules of its own.

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
- **Direct data access today:** both Workers take `MONGODB_URI` and use the
  mongodb driver, which should go through the api-gateway. They also hold D1,
  KV, Durable Object and queue bindings; whether Worker-local state like that
  is allowed has not been decided, so ask the owner before adding more.
- **Direction, MCP server:** Rust where possible. The TypeScript MCP stays
  until a Rust one is viable; the Mzizi `mzizi-backend` skill also still
  describes a TypeScript host (the MCP SDK and `agents` are TypeScript-first).
  `rmcp` (the Rust MCP SDK on crates.io, 3.5.1) is a candidate; whether it
  builds for the Workers wasm target has not been checked, so the tracking
  issue must settle that first. The tools call the one business backend; they
  do not hold business rules of their own.
- **MCP Apps are the exception.** The interactive views an MCP server returns
  (for example the places map card) are HTML or TypeScript, because the MCP
  Apps format needs it. They are not Astro and not Rust, and they stay thin:
  rendering only, with the data and rules behind the tool.
- Do not port a working Worker without a tracking issue. When one is ported,
  its existing tests are the contract the port must meet.

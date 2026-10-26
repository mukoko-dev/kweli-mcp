# AGENTS.md — kweli-mcp

Rules for any AI agent working in this repository. [`README.md`](./README.md) describes
the Workers (`apps/mcp`, `apps/bulk-place-agent`, `apps/single-place-agent`) and the
shared packages; [`MIGRATION.md`](./MIGRATION.md) holds the architecture decisions and
the cutover from the Next.js MCP in `mukoko-dev/kweli`.

- Branch from `staging` and open every PR against `staging`.
- Before pushing, run `pnpm turbo run type-check test` from the repo root.

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
  and the owner promotes `staging` to `main` with a release branch that carries
  `staging`'s exact tree, landed through the merge queue (squash only, no merge
  commits). Nothing goes to `main` directly.
- **Big moves need an issue first.** A rewrite (a framework or a language)
  gets a tracking issue that names the entity it belongs to, what it
  replaces and the metric it moves, before any code.
- **Layers.** A frontend calls a backend, and a backend calls the Nyuchi API
  (the api-gateway, `api.nyuchi.com`). The API is not a backend: backends are
  Workers that sit on top of it, and none has direct database access (no
  external database driver or connection string). A frontend on a
  Cloudflare Worker reaches its backend through a service binding. A frontend
  on Vercel reaches its backend the same way a backend reaches the API, with a
  short-lived token bound to its own key, so no single shared credential
  exposes everything (owner decision, 2026-10-14). How the Vercel side holds
  that key is not designed yet.
- **One backend per domain** (owner decision, 2026-10-14). A domain generally
  has one backend Worker, like `nyuchi-console-backend`, and not many small
  ones. Backends in different domains connect to each other through service
  bindings. Backends are parts of one platform: when one needs another it
  calls it directly through a service binding and does not round-trip through
  the API (owner decision, 2026-10-14). The API stays the way to reach data.
- **Business backend: `mukoko-business-backend`.** One new Rust Worker (not
  built yet) that Verify and Kweli sit on. It verifies WorkOS. Verify stays a
  Worker and reaches it through a service binding; Kweli can run on Vercel.
  This MCP server uses it too; as a Worker it reaches it
  through a service binding. Neither UI should keep a data store or business
  rules of its own. How the backend calls the API (a five-minute machine token
  bound to its own key, acting for a person only within its reach) is set by the
  Nyuchi Trust Architecture, approved 2026-10-13; its phase 1 is next.
- **Worker-local state is allowed** (owner decision, 2026-10-14): the
  Cloudflare bindings of a Worker, such as D1, KV, R2, Durable Objects and
  queues. Kweli and Verify may also use Analytics Engine and Workflows. A
  database driver or connection string for an external database is still not
  allowed.

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
  KV, Durable Object and queue bindings, which are allowed Worker-local state.
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

## Merging and releases (org rule, 2026-10-21)

The owner set this for every repo in every org on 2026-10-21. It replaces any older
wording about merge commits, rebase merges, forward-ports or "staging to main" PRs.

- **Squash only, through the merge queue.** `staging` and `main` take squash merges
  through a GitHub merge queue. Rebase and merge commits are disabled, and history is
  linear. Land a PR with `gh pr merge <n> --squash --auto`. The queue tests it against
  the latest base and merges it. Never use `--admin`, and don't loop merge calls: treat a
  5xx or "merge already in progress" as "wait".
- **No "require up to date".** The queue keeps PRs current, so that setting is off.
  "Update branch" is fine.
- **One writer per branch.** Use `--force-with-lease` only on a branch you own.
- **Every required check runs on `merge_group:`.** A workflow whose check is required
  triggers on `merge_group:` as well as `pull_request:`, or queued PRs stall for 60
  minutes and drop out. Jobs that only make sense on a pull request skip with
  `if: github.event_name != 'merge_group'` (a skipped required check counts as passing).
- **Releases.** Cut `release/staging-to-main-<date>` from `main`, give it `staging`'s
  exact tree, and land it in `main` through the queue. Only the owner releases, or an
  agent the owner has authorised for that release.
- **First-party packages** (`@nyuchi/*`, `@bundu/*`, `mzizi-*`) are depended on by
  minimum version (`>=x.y.z`), with no upper bound.

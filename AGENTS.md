# AGENTS.md — kweli-mcp

Rules for any AI agent working in this repository. [`README.md`](./README.md) describes
the Workers (`apps/mcp`, `apps/bulk-place-agent`, `apps/single-place-agent`) and the
shared packages; [`MIGRATION.md`](./MIGRATION.md) holds the architecture decisions and
the cutover from the Next.js MCP in `mukoko-dev/kweli`.

- Branch from `main` and open every PR against `main`.
- Before pushing, run `pnpm turbo run type-check test` from the repo root.

## Merging and releases (org rule, 2026-10-21)

The owner set this for every repo in every org on 2026-10-21. It replaces any older
wording about merge commits, rebase merges, forward-ports or staging PRs.

- **Squash only, through the merge queue.** `main` takes squash merges
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
- **Releases.** Every merge to `main` is a release, tagged from its PR title. Only the
  owner makes a major release.
- **First-party packages** (`@nyuchi/*`, `@bundu/*`, `mzizi-*`) are depended on by
  minimum version (`>=x.y.z`), with no upper bound.

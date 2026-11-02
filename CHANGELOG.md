# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **The Kweli MCP (`apps/mcp`) runs on the official MCP TypeScript SDK v2**
  ([#57](https://github.com/mukoko-dev/kweli-mcp/issues/57)).
  `@modelcontextprotocol/server` 2.4.0 replaces `@modelcontextprotocol/sdk`
  1.32.1 and the `agents` package. The `KweliMcp` McpAgent Durable Object
  (one MCP session per object) is gone. `/mcp` is now the SDK's stateless
  Streamable HTTP handler with a fresh server per request: no
  `Mcp-Session-Id`, `GET` answers 405, and 2026-07-28 clients are served as
  well as 2025-era ones. The `v2` migration in `wrangler.jsonc` deletes the
  class; it held session state only. Mongo is now one client per request,
  closed when the request ends.
- **Tools are renamed with a `kweli_` prefix** (`kweli_search_places`,
  `kweli_get_place`, …). `task_status` and `task_records` become
  `kweli_get_task_status` and `kweli_get_task_records`. Every old name,
  including the Next.js MCP's `search_venues` and `get_venue`, stays callable
  as an unlisted alias on both the anonymous and the signed-in door. The
  open/gated split is unchanged.
- **Every tool**:
  - has a top-level `title`, a when-to-use description, all four annotations
    (generation tools are now `openWorldHint: true`) and an `outputSchema`;
  - returns `structuredContent` whose JSON is exactly the text block;
  - has bounded, described inputs (lat/lng ranges, string and limit bounds).
- **List tools paginate.** `kweli_search_places`, `kweli_list_recent_places`,
  `kweli_list_geo_areas`, `kweli_overpass_lookup` and `kweli_get_task_records`
  take `limit`/`offset` and return `total`, `count`, `has_more` and
  `next_offset`. Results are kept under a 25,000-character limit by returning
  fewer items.
- **Errors are actionable `isError` results** with no internal detail. An
  unconfigured graph now says "The Kweli graph is not connected on this
  deployment yet" instead of naming the missing secret.
- **Timeouts everywhere**: 25 s on Overpass, Nominatim and agent calls, and
  10 s `maxTimeMS` on every Mongo operation.

### Security

- `/mcp` validates `Origin` (a MUST of the Streamable HTTP transport). A foreign
  browser Origin gets 403; extra hosts can be allowed with
  `MCP_ALLOWED_ORIGINS`.
- The OAuth provider no longer accepts `plain` PKCE (`allowPlainPKCE: false`).
- `kweli_overpass_lookup` and `kweli_resolve_hierarchy` no longer accept an
  upstream endpoint argument; the Overpass and Nominatim endpoints are fixed
  server-side.

### Added

- `apps/mcp/test/sdk-server.test.ts`: 15 tests that drive the server through
  the SDK's own `Client` (tools/list, pagination, structured results, errors,
  legacy aliases, Origin, 405, the anonymous 401 with `resource_metadata`).
- `apps/mcp/evals/evals.xml`: ten read-only evaluations with
  string-comparable answers, verified through the SDK client.

### Fixed

- **The verification ladder has five tiers, not four.** `get_verification`'s
  description said "the 4-tier Mukoko ladder" while listing tiers 0 to 4;
  `clampTier` in `@kweli-mcp/mongo` clamps to 0–4 and `VERIFICATION_TIERS` has
  five entries. The description and the `verification-tiers.ts` header now say
  five tiers (0 unverified, 1 community, 2 otp "Contact Verified", 3
  government, 4 licensed), matching the Mzizi registry's `--tier-*` roles
  ([mzizi-dev/mzizi-registry#543](https://github.com/mzizi-dev/mzizi-registry/issues/543)).
  Wording only; no tool behaviour changes.

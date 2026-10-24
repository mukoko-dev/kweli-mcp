# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **The verification ladder has five tiers, not four.** `get_verification`'s
  description said "the 4-tier Mukoko ladder" while listing tiers 0 to 4;
  `clampTier` in `@kweli-mcp/mongo` clamps to 0–4 and `VERIFICATION_TIERS` has
  five entries. The description and the `verification-tiers.ts` header now say
  five tiers (0 unverified, 1 community, 2 otp "Contact Verified", 3
  government, 4 licensed), matching the Mzizi registry's `--tier-*` roles
  ([mzizi-dev/mzizi-registry#543](https://github.com/mzizi-dev/mzizi-registry/issues/543)).
  Wording only; no tool behaviour changes.

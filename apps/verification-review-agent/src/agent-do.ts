/**
 * VerificationReviewAgent — STUB. Assists (never replaces) the human review
 * of `entity.representativeClaims` pending rows — Kweli's claim → verify
 * flow (see kweli's `lib/services/claims.service.ts` and the admin console
 * at `/dashboard/admin/claims`).
 *
 * Deliberately NOT autonomous: this agent only drafts and flags, it never
 * changes `bundu.verificationTier` itself. Kweli's own admin approval flow
 * remains the sole writer of verification tiers — same non-negotiable rule
 * as the api-gateway's `kweli` namespace (read-only) and this monorepo's
 * bulk/single ingestion agents (tier 0 only, never higher).
 *
 * TODO (real implementation):
 *   1. Read pending `entity.representativeClaims` rows (needs a Mongo read
 *      via @kweli-mcp/mongo — claims live in `entity`, same db as entities).
 *   2. For each claim, fetch `evidenceUrl` and summarize it (Workers AI via
 *      the shamwari AI Gateway, same binding pattern as
 *      apps/bulk-ingestion-agent's generateDescription skill).
 *   3. Flag anomalies: evidence domain mismatch vs. the entity's own
 *      website, a claimant with no prior activity, a duplicate claim on the
 *      same entity from a different person.
 *   4. Write the summary + flags as a review-note attached to the claim
 *      (entity.representativeClaims.reviewNotes, or a new sub-collection —
 *      confirm the exact field with the platform team before writing;
 *      per kweli's CLAUDE.md "single source of truth" rule, do not invent a
 *      parallel collection).
 *   5. Never set claim.status to "approved"/"rejected" — that stays a human
 *      action in Kweli's own admin console.
 */

import { Agent } from "agents";

export interface ClaimReviewState {
  claimId: string | null;
  status: "not_implemented";
}

export class VerificationReviewAgent extends Agent<Env, ClaimReviewState> {
  initialState: ClaimReviewState = { claimId: null, status: "not_implemented" };

  async draftReview(claimId: string): Promise<{ claimId: string; status: string; note: string }> {
    this.setState({ claimId, status: "not_implemented" });
    return {
      claimId,
      status: "not_implemented",
      note: "VerificationReviewAgent is a stub — see agent-do.ts TODO. No evidence summary was generated.",
    };
  }
}

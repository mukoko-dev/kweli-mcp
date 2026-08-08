// verification-review-agent worker entrypoint — STUB (see agent-do.ts).
// Owns `POST /claims/{claimId}/draft-review`, meant for Kweli's admin
// console to call once this is real (not wired from Kweli yet).

import { getAgentByName } from "agents";
import { VerificationReviewAgent } from "./agent-do";

export { VerificationReviewAgent };

interface Env {
  VERIFICATION_REVIEW_AGENT: DurableObjectNamespace<VerificationReviewAgent>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "kweli-verification-review-agent", status: "stub" });
    }

    const match = url.pathname.match(/^\/claims\/([^/]+)\/draft-review$/);
    if (match && request.method === "POST") {
      const claimId = match[1];
      const agent = await getAgentByName<Env, VerificationReviewAgent>(
        env.VERIFICATION_REVIEW_AGENT,
        claimId,
      );
      return json(await agent.draftReview(claimId));
    }

    return json({ error: "not found" }, 404);
  },
};

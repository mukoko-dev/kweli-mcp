import type { VerificationReviewAgent } from "./agent-do";

export {};

declare global {
  interface Env {
    VERIFICATION_REVIEW_AGENT: DurableObjectNamespace<VerificationReviewAgent>;
  }
}

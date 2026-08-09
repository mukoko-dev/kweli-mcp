import type { SinglePlaceAgent } from "./agent-do";

export {};

declare global {
  interface Env {
    SINGLE_PLACE_AGENT: DurableObjectNamespace<SinglePlaceAgent>;

    // WorkOS M2M — this agent's own dedicated application, distinct from
    // bulk-place-agent's. No org restriction (unset WORKOS_ALLOWED_ORG_IDS):
    // any Nyuchi/Mukoko app holding this client_id/secret pair may call
    // POST /tasks directly.
    WORKOS_AUTHKIT_DOMAIN: string;
    WORKOS_M2M_CLIENT_ID: string;

    // The shared Mukoko cluster — same collections bulk-place-agent writes to.
    MONGODB_URI: string;
  }
}

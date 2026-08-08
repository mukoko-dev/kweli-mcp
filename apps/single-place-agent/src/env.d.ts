import type { SinglePlaceAgent } from "./agent-do";

export {};

declare global {
  interface Env {
    SINGLE_PLACE_AGENT: DurableObjectNamespace<SinglePlaceAgent>;
  }
}

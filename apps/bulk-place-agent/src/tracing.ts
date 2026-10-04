// Metadata-only agent tracing (Workers custom spans, OpenTelemetry GenAI
// conventions). Fundi owns its own loop, so this is the "custom harness"
// branch of Cloudflare's agent tracing: one `invoke_agent` span per task with
// a `chat` span per model call. Owner decision 2026-10-04: METADATA ONLY — no
// messages, system instructions or outputs are ever set as attributes.

// Namespace import, not `import { tracing }`: a named import the runtime does
// not provide fails at module link time and would take the whole Worker down;
// a missing namespace property just leaves tracing off.
import * as workers from "cloudflare:workers";

export const AGENT_NAME = "kweli-bulk-place-agent";

type Attrs = Record<string, string | number | boolean>;

function identity(conversationId: string): Attrs {
  return {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.agent.id": AGENT_NAME,
    // The task id: an opaque uuid, no user data.
    "gen_ai.conversation.id": conversationId,
  };
}

function withSpan<T>(
  name: string,
  attrs: Attrs,
  fn: () => Promise<T>,
): Promise<T> {
  // Defensive: run untraced if the runtime does not expose the API.
  const tracing = (workers as { tracing?: Tracing }).tracing;
  if (!tracing?.enterSpan) return fn();
  return tracing.enterSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    return fn();
  });
}

export function invokeAgentSpan<T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    "invoke_agent",
    { "gen_ai.operation.name": "invoke_agent", ...identity(taskId) },
    fn,
  );
}

export function chatSpanFor(taskId: string) {
  return <T>(model: string, fn: () => Promise<T>): Promise<T> =>
    withSpan(
      "chat",
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "cloudflare.workers_ai",
        "gen_ai.request.model": model,
        ...identity(taskId),
      },
      fn,
    );
}

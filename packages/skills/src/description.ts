// Skill: generate_description (§4.6 + §6). Workers AI via the `fundi` AI
// Gateway (background agents), with the v10 guard carried forward:
// clean-or-absent, never a hedge.
//
// This runs ONLY in the autonomous queue/app-surface path — never when a
// platform-team LLM is already driving Fundi over MCP (no point running an AI to
// run an AI). The previous enrichment saved any model output >=20 chars, so
// hedges ("I don't have specific information…") polluted ~65% of descriptions.
// Do NOT regress this.

import type { OsmFeature } from "./classify";

// Case-insensitive patterns that mark a refusal / hedge / meta-commentary.
const HEDGE_ANYWHERE = [
  "i don't have",
  "i do not have",
  "i cannot",
  "i can't",
  "i'm unable",
  "i am unable",
  "i'd be happy to",
  "following the rule",
  "here's what i can",
  "no specific information",
  "no reliable information",
  "no verified information",
  "based on the limited information",
  "cannot provide",
  "as an ai",
  "unfortunately, i",
];

const HEDGE_LEADING = [
  "i ",
  "i'",
  "i’",
  "i'm",
  "i am",
  "i'd",
  "as an ai",
  "unfortunately, i",
  "sure,",
  "certainly,",
  "here is",
  "here's",
  "description:",
];

export function isHedge(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === "skip") return true;
  if (HEDGE_LEADING.some((p) => lower.startsWith(p))) return true;
  if (HEDGE_ANYWHERE.some((p) => lower.includes(p))) return true;
  if (trimmed.length < 20) return true;
  return false;
}

const BASE_PROMPT =
  "Write a place description in third person, present tense, factual only. " +
  "No opening hours, no contact details. Do not start with 'Welcome to' or 'Located in'. " +
  "Warm professional tone, 2-3 sentences. Output ONLY the description.";

const STRICT_SUFFIX =
  " If you lack enough specific information, reply with exactly the single word SKIP. " +
  "Never explain what you don't know. Output ONLY the description or SKIP.";

function buildContext(feature: OsmFeature, placeName: string): string {
  const t = feature.tags ?? {};
  const facts: string[] = [`Name: ${placeName}`];
  const interesting = [
    "tourism",
    "amenity",
    "shop",
    "natural",
    "leisure",
    "cuisine",
    "addr:city",
    "addr:country",
    "description",
    "operator",
  ];
  for (const key of interesting) {
    if (t[key]) facts.push(`${key}: ${t[key]}`);
  }
  return facts.join("\n");
}

// Workers AI binding + model, routed through an AI Gateway (`fundi` — the
// background agents gateway: authenticated, no guardrails, no cache).
export interface AiConfig {
  binding: Ai;
  // Direct Workers AI model id. Used on its own, or as the fallback when the
  // dynamic route below is not configured on the gateway yet.
  model: string;
  // AI Gateway dynamic route (e.g. "dynamic/places"). Preferred when set: the
  // model choice then lives in gateway configuration, not in this code.
  route?: string;
  gateway?: string;
  // Attribution for the gateway log: who called and for which job. Scalars
  // only, and never content — the gateway keeps these on every log row.
  metadata?: Record<string, string | number | boolean>;
  // Daily request budget. Called once before EVERY model call; false means the
  // day's budget is spent (or cannot be checked) and no call is made.
  reserve?: () => Promise<boolean>;
  // Tracing hook: wraps one model call in a metadata-only `chat` span. Kept as
  // an injected function so this module stays free of `cloudflare:workers`
  // (the guard tests run in plain Node).
  span?: <T>(model: string, fn: () => Promise<T>) => Promise<T>;
}

// The day's AI budget is spent. Not a failure of the place: generation stops,
// the place is written without a description and stays re-enrichable.
export class AiBudgetExceededError extends Error {}

// Gateway options for the binding's third argument. Exported for the tests:
// a gateway passed anywhere else is silently ignored by the binding.
export function gatewayOptions(
  cfg: Pick<AiConfig, "gateway" | "metadata">,
): { gateway: Record<string, unknown> } | undefined {
  if (!cfg.gateway) return undefined;
  return {
    gateway: {
      id: cfg.gateway,
      // Every prompt is a distinct place; a cache would never hit.
      skipCache: true,
      ...(cfg.metadata ? { metadata: cfg.metadata } : {}),
    },
  };
}

// A dynamic route that does not exist on the gateway fails with code 7003
// ("Dynamic route 'places' not found"). That is configuration, not the place.
export function isMissingRoute(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /7003|dynamic route .* not found/i.test(msg);
}

// Per isolate: once a route is known to be missing, go straight to the direct
// model for a while instead of paying a failed call before every description.
const ROUTE_RETRY_MS = 10 * 60 * 1000;
const routeMissingUntil = new Map<string, number>();

export function resetRouteCache(): void {
  routeMissingUntil.clear();
}

// Qwen3 reasons before answering unless told not to; for 2-3 sentences of
// prose that hidden reasoning is pure cost (measured: 242 → 25 completion
// tokens on a trivial call). Harmless to other models.
const NO_THINK = " /no_think";

// Workers AI models answer `{response}`; dynamic routes and OpenAI-compatible
// models answer the chat-completions shape. Strip any (empty) think block.
export function extractText(out: unknown): string {
  const o = (out ?? {}) as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  // First non-empty string wins: some models fill both fields, and an empty
  // `response` must not hide the chat-completions content.
  const text =
    [o.response, o.choices?.[0]?.message?.content].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    ) ?? "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function runModel(
  cfg: AiConfig,
  system: string,
  user: string,
): Promise<string> {
  const call = async (model: string) => {
    if (cfg.reserve && !(await cfg.reserve())) {
      throw new AiBudgetExceededError("daily AI request budget spent");
    }
    // A dynamic route or provider-prefixed id is not a static AiModels key —
    // hence the casts.
    const run = () =>
      cfg.binding.run(
        model as never,
        {
          messages: [
            { role: "system", content: system + NO_THINK },
            { role: "user", content: user },
          ],
          max_tokens: 256,
        } as never,
        gatewayOptions(cfg) as never,
      );
    return extractText(cfg.span ? await cfg.span(model, run) : await run());
  };

  const route = cfg.route;
  if (route && (routeMissingUntil.get(route) ?? 0) <= Date.now()) {
    try {
      return await call(route);
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
      routeMissingUntil.set(route, Date.now() + ROUTE_RETRY_MS);
      console.warn("generate_description: dynamic route missing; using model", {
        route,
      });
    }
  }
  return call(cfg.model);
}

// Returns a clean description, or null. Never returns a hedge.
export async function generateDescription(
  cfg: AiConfig | null,
  feature: OsmFeature,
  placeName: string,
): Promise<string | null> {
  if (!cfg) return null;
  const context = buildContext(feature, placeName);

  try {
    const first = await runModel(cfg, BASE_PROMPT, context);
    if (!isHedge(first)) return first.trim();

    // Retry once, stricter (§6).
    const second = await runModel(cfg, BASE_PROMPT + STRICT_SUFFIX, context);
    if (!isHedge(second)) return second.trim();
  } catch (e) {
    if (e instanceof AiBudgetExceededError) {
      console.warn("generate_description skipped: daily AI budget spent", {
        id: feature.id,
      });
      return null;
    }
    console.error("generate_description failed", {
      id: feature.id,
      error: String(e),
    });
  }
  // Clean null beats a polluted string. Place stays re-enrichable later.
  return null;
}

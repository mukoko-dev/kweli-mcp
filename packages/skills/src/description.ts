// Skill: generate_description (§4.6 + §6). Workers AI (Kimi via the shamwari AI
// Gateway), with the v10 guard carried forward: clean-or-absent, never a hedge.
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

// Workers AI binding + model, optionally routed through an AI Gateway (shamwari).
export interface AiConfig {
  binding: Ai;
  model: string;
  gateway?: string;
}

async function runModel(cfg: AiConfig, system: string, user: string): Promise<string> {
  // Through an AI Gateway the model id is provider-prefixed
  // ("workers-ai/@cf/…"), which is not a static AiModels key — hence the casts.
  const options = cfg.gateway ? { gateway: { id: cfg.gateway } } : undefined;
  const out = (await cfg.binding.run(
    cfg.model as never,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 256,
    } as never,
    options as never,
  )) as { response?: string };
  return (out.response ?? "").trim();
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
    console.error("generate_description failed", { id: feature.id, error: String(e) });
  }
  // Clean null beats a polluted string. Place stays re-enrichable later.
  return null;
}

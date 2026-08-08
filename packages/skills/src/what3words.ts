// Skill: resolve_what3words (§4.4). lat/lng → 3-word address via the w3w API.
// A *replaceable convenience layer*, resolved at write time only and persisted.
// Best-effort: on failure leave what3words null and continue. Never load-bearing.

export interface What3WordsConfig {
  endpoint: string; // e.g. https://api.what3words.com/v3/convert-to-3wa
  apiKey: string;
}

export async function resolveWhat3Words(
  cfg: What3WordsConfig | null,
  lat: number,
  lng: number,
): Promise<string | null> {
  if (!cfg) return null;
  try {
    const url = new URL(cfg.endpoint);
    url.searchParams.set("coordinates", `${lat},${lng}`);
    url.searchParams.set("key", cfg.apiKey);
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { words?: string };
    return data.words ?? null;
  } catch (e) {
    console.error("resolve_what3words failed", { lat, lng, error: String(e) });
    return null;
  }
}

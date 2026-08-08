// Sovereignty doctrine (§0.5): Fundi reads its sources/skills config from the
// MongoDB provider registry (integrations.providers + .providerConfigurations).
// Endpoints come from the registry; credentials are resolved BY REFERENCE — the
// registry holds the name of a secret, never the secret itself. Secrets live in
// the Worker's secret store (env). Sensible defaults keep the open providers
// working even before the registry is populated.

import type { Db } from "mongodb";

export interface ProviderConfig {
  providerKey: string;
  endpoint?: string;
  credentialsRef?: string; // name of the env secret holding the key
  model?: string;
  enabled?: boolean;
  [k: string]: unknown;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openstreetmap: "https://overpass-api.de/api/interpreter",
  nominatim: "https://nominatim.openstreetmap.org",
  wikidata: "https://www.wikidata.org/wiki/Special:EntityData",
  what3words: "https://api.what3words.com/v3/convert-to-3wa",
  anthropic: "https://api.anthropic.com/v1/messages",
  geoboundaries: "https://www.geoboundaries.org/api/current/gbOpen",
};

const DEFAULT_CRED_REFS: Record<string, string> = {
  what3words: "WHAT3WORDS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export class ProviderRegistry {
  private cache = new Map<string, ProviderConfig | null>();

  constructor(
    private db: Db,
    private env: Record<string, string | undefined>,
  ) {}

  private async load(providerKey: string): Promise<ProviderConfig | null> {
    if (this.cache.has(providerKey)) return this.cache.get(providerKey)!;
    let config: ProviderConfig | null = null;
    try {
      const doc = await this.db
        .collection<ProviderConfig>("providerConfigurations")
        .findOne({ providerKey });
      config = doc ?? null;
    } catch (e) {
      console.error("registry lookup failed; using defaults", { providerKey, error: String(e) });
    }
    this.cache.set(providerKey, config);
    return config;
  }

  async endpoint(providerKey: string): Promise<string> {
    const cfg = await this.load(providerKey);
    return cfg?.endpoint ?? DEFAULT_ENDPOINTS[providerKey] ?? "";
  }

  // Resolves a credential strictly by reference: registry → env secret name.
  async credential(providerKey: string): Promise<string | null> {
    const cfg = await this.load(providerKey);
    const ref = cfg?.credentialsRef ?? DEFAULT_CRED_REFS[providerKey];
    if (!ref) return null;
    return this.env[ref] ?? null;
  }

  async model(providerKey: string, fallback: string): Promise<string> {
    const cfg = await this.load(providerKey);
    return cfg?.model ?? fallback;
  }
}

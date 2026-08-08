// Skill: enrich_wikidata (§4.5). If the OSM feature carries a `wikidata` tag,
// fetch the QID → multilingual labels, sameAs links, cross-ref identifiers.
// Best-effort: any failure yields an empty enrichment and the pipeline continues.

export interface WikidataEnrichment {
  qid: string;
  labels: Record<string, string>;
  sameAs: string[];
  identifiers: Record<string, string>;
}

const QID_RE = /^Q\d+$/;

export interface WikidataDeps {
  // Special:EntityData base, e.g. https://www.wikidata.org/wiki/Special:EntityData
  endpoint: string;
}

export async function enrichWikidata(
  deps: WikidataDeps | null,
  qidTag: string | undefined,
): Promise<WikidataEnrichment | null> {
  if (!deps || !qidTag || !QID_RE.test(qidTag)) return null;
  try {
    const res = await fetch(`${deps.endpoint}/${qidTag}.json`, {
      headers: {
        accept: "application/json",
        "user-agent": "Mukoko-Platform/1.0 (hello@nyuchi.com)",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      entities?: Record<
        string,
        {
          labels?: Record<string, { value: string }>;
          sitelinks?: Record<string, { url?: string; title?: string }>;
          claims?: Record<string, unknown>;
        }
      >;
    };
    const entity = data.entities?.[qidTag];
    if (!entity) return null;

    const labels: Record<string, string> = {};
    for (const [lang, v] of Object.entries(entity.labels ?? {})) {
      labels[lang] = v.value;
    }

    const sameAs: string[] = [];
    for (const link of Object.values(entity.sitelinks ?? {})) {
      if (link.url) sameAs.push(link.url);
    }
    sameAs.push(`https://www.wikidata.org/wiki/${qidTag}`);

    return { qid: qidTag, labels, sameAs, identifiers: { wikidata: qidTag } };
  } catch (e) {
    console.error("enrich_wikidata failed", { qid: qidTag, error: String(e) });
    return null;
  }
}

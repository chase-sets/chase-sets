// Discovery consumes the published Catalog resolved-alias fact only. These
// shapes mirror the `aliases[]` entries of `catalog.catalog-item.aliases-resolved`
// and `catalog.reference-record.aliases-resolved`. Discovery never reads
// alias candidates, provider profiles, or the alias review state machine; it
// applies its own search weighting and dedupe over the stable fact.

export type ResolvedAliasType =
  | "official-equivalent"
  | "provider-localized-name"
  | "species-name"
  | "literal-translation"
  | "romanization"
  | "generated-translation"
  | "set-equivalent"
  | "series-equivalent";

export type ResolvedAliasConfidence = "exact" | "high" | "candidate" | "generated" | "manual";

export type ResolvedAlias = Readonly<{
  aliasHash: string;
  aliasText: string;
  normalizedAliasText: string;
  aliasType: ResolvedAliasType;
  confidence: ResolvedAliasConfidence;
  broad: boolean;
  providerKey?: string;
  sourceCategory?: string;
}>;

// Postgres ts_rank weights: A=1.0, B=0.4, C=0.2, D=0.1. Title and subtitle keep
// their own weights in the projection; aliases never outrank the resolved
// display identity, so the strongest alias tier (A) sits alongside the title and
// every broad/low-trust alias is pushed down so a species name can never outrank
// an exact title or an official equivalent.
export type SearchTextWeight = "A" | "B" | "C" | "D";

export type WeightedAliasText = Readonly<{
  weight: SearchTextWeight;
  text: string;
}>;

/**
 * Type- and confidence-aware base weight for an alias, before the broad/cardinality
 * down-weight is applied. Matches the ADR's recommended weighting:
 * official-equivalent high; accepted set/series high/medium; species medium;
 * romanization/generated low.
 */
function baseAliasWeight(alias: ResolvedAlias): SearchTextWeight {
  switch (alias.aliasType) {
    case "official-equivalent":
      // The strongest non-identity equivalence. High = alongside the title.
      return "A";
    case "set-equivalent":
    case "series-equivalent":
      // Accepted set/series alias: high at exact, medium otherwise.
      return alias.confidence === "exact" ? "A" : "B";
    case "species-name":
      // Shared creature/species name: medium, and always broad in practice.
      return "B";
    case "provider-localized-name":
    case "literal-translation":
      // A governed localized or dictionary name: medium-low.
      return "C";
    case "romanization":
    case "generated-translation":
      // Romanization / machine translation: lowest trust.
      return "D";
  }
}

const WEIGHT_ORDER: readonly SearchTextWeight[] = ["A", "B", "C", "D"];

function demoteWeight(weight: SearchTextWeight): SearchTextWeight {
  const index = WEIGHT_ORDER.indexOf(weight);
  return WEIGHT_ORDER[Math.min(index + 1, WEIGHT_ORDER.length - 1)];
}

/**
 * Resolves the final search weight for an alias. Generated-confidence aliases are
 * always pinned to the lowest tier regardless of type, and a `broad` alias (one
 * whose text fans out to many Catalog Items, e.g. a species name) is demoted one
 * tier so it can never outrank a specific alias or an exact title match.
 */
export function resolveAliasWeight(alias: ResolvedAlias): SearchTextWeight {
  if (alias.confidence === "generated") {
    return "D";
  }

  const base = baseAliasWeight(alias);
  return alias.broad ? demoteWeight(base) : base;
}

/**
 * Buckets an item's resolved aliases into weighted, deduplicated text segments
 * for the `search_text` / `search_text_simple` tsvectors. Dedupe is by alias hash
 * so the same alias surfaced by several sources contributes once; when one alias
 * text appears at multiple weights the strongest weight wins so a broad copy
 * never dilutes a specific one.
 */
export function weightedAliasTexts(aliases: readonly ResolvedAlias[]): WeightedAliasText[] {
  const strongestByText = new Map<string, SearchTextWeight>();
  const seenHashes = new Set<string>();

  for (const alias of aliases) {
    const text = alias.aliasText.trim();
    if (!text || seenHashes.has(alias.aliasHash)) {
      continue;
    }
    seenHashes.add(alias.aliasHash);

    const weight = resolveAliasWeight(alias);
    const existing = strongestByText.get(text);
    if (!existing || WEIGHT_ORDER.indexOf(weight) < WEIGHT_ORDER.indexOf(existing)) {
      strongestByText.set(text, weight);
    }
  }

  return [...strongestByText.entries()].map(([text, weight]) => ({ weight, text }));
}

/** Groups weighted alias texts into one joined string per weight tier. */
export function aliasTextByWeight(aliases: readonly ResolvedAlias[]): Readonly<Record<SearchTextWeight, string>> {
  const buckets: Record<SearchTextWeight, string[]> = { A: [], B: [], C: [], D: [] };
  for (const { weight, text } of weightedAliasTexts(aliases)) {
    buckets[weight].push(text);
  }

  return {
    A: buckets.A.join(" "),
    B: buckets.B.join(" "),
    C: buckets.C.join(" "),
    D: buckets.D.join(" "),
  };
}

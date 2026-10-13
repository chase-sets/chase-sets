import { buildSimpleSearchQuery, foldSearchDiacritics, normalizeSimpleSearchText } from "./normalization";
import { classifyProtectedSearchTokens, type ServedSearchSetCodeLookup } from "./protected-search-tokens";

// Reviewed buyer vocabulary: sealed-product abbreviations, franchise shorthand,
// and the Charizard nickname. These are query alternatives, not Catalog aliases.
export const SEARCH_SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  etb: "elite trainer box",
  bb: "booster box",
  pkmn: "pokemon",
  zard: "charizard",
  ygo: "yu-gi-oh",
});

export function isSearchSynonym(token: string): boolean {
  return Object.hasOwn(SEARCH_SYNONYMS, normalizeSimpleSearchText(token).toLowerCase());
}

export type SearchSynonymQueries = Readonly<{ english: string; simple: string; expanded: boolean }>;

export async function buildSearchSynonymQueries(
  value: string,
  lookup: ServedSearchSetCodeLookup,
  prefix = false,
): Promise<SearchSynonymQueries> {
  const tokens = await classifyProtectedSearchTokens(value, lookup);
  const alternatives = tokens.map(({ raw, protected: protectedToken }) => {
    const key = normalizeSimpleSearchText(raw).toLowerCase();
    return !protectedToken && Object.hasOwn(SEARCH_SYNONYMS, key) ? SEARCH_SYNONYMS[key] : null;
  });
  // Keep the existing plain-query path when no alternatives or compound literal
  // numbers are needed, including its English punctuation/stop-word semantics.
  const expanded = alternatives.some(Boolean) || tokens.some(({ raw }) => /\p{N}/u.test(raw) && /[./-]/.test(raw));
  if (!expanded && !prefix) {
    return { english: foldSearchDiacritics(value), simple: buildSimpleSearchQuery(value), expanded: false };
  }
  const build = (normalize: (text: string) => string, english = false) =>
    tokens
      .map(({ raw, protected: protectedToken }, index) => {
        const final = prefix && index === tokens.length - 1;
        const expression = (text: string, phrase: boolean) => {
          const words = normalize(text).split(" ").filter(Boolean);
          const query = words
            .map((word, wordIndex) => `${word}${final && wordIndex === words.length - 1 ? ":*" : ""}`)
            .join(phrase ? " <-> " : " & ");
          return query;
        };
        const original =
          english && protectedToken
            ? `${foldSearchDiacritics(raw)}${final ? ":*" : ""}`
            : expression(raw, protectedToken);
        const alternative = alternatives[index];
        const literal = protectedToken && original.includes(" <-> ") ? `(${original})` : original;
        return alternative ? `(${literal} | (${expression(alternative, true)}))` : literal;
      })
      .join(" & ");
  return { english: build(normalizeSimpleSearchText, true), simple: build(buildSimpleSearchQuery), expanded: true };
}

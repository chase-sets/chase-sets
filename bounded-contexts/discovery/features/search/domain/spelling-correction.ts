import { buildSimpleSearchQuery, normalizeSimpleSearchText } from "./normalization";
import type { ProtectedSearchToken } from "./protected-search-tokens";
import { SEARCH_SYNONYMS, type SearchSynonymQueries } from "./search-synonyms";

export type SearchCorrectionTerms = Readonly<{ literal: boolean; prefix: boolean; candidates: readonly string[] }>;
export type SearchCorrectionTermLookup = (token: string) => Promise<SearchCorrectionTerms>;

export function protectedSearchQuery(tokens: readonly ProtectedSearchToken[]): string {
  return tokens
    .filter((token) => token.protected)
    .map(({ raw }) => {
      const original = normalizeSimpleSearchText(raw).toLowerCase();
      const unpadded = original.replace(/\b0+(?=\d)/g, "");
      const phrase = (value: string) => `(${value.split(" ").join(" <-> ")})`;
      return original === unpadded ? phrase(original) : `(${phrase(original)} | ${phrase(unpadded)})`;
    })
    .join(" & ");
}

export async function buildSpellingCorrectionQueries(
  tokens: readonly ProtectedSearchToken[],
  lookup: SearchCorrectionTermLookup,
): Promise<SearchSynonymQueries | null> {
  const hasProtected = tokens.some((token) => token.protected);
  let lookups = 0;
  let rewrites = 0;
  const english: string[] = [];
  const simple: string[] = [];
  const memo = new Map<string, SearchCorrectionTerms>();
  const expression = (value: string, simpleQuery: boolean) =>
    (simpleQuery ? buildSimpleSearchQuery(value) : normalizeSimpleSearchText(value))
      .toLowerCase()
      .split(" ")
      .join(" <-> ");

  for (const [index, token] of tokens.entries()) {
    const key = normalizeSimpleSearchText(token.raw).toLowerCase();
    if (token.protected) {
      const query = protectedSearchQuery([token]);
      english.push(query);
      simple.push(query);
      continue;
    }
    const synonym = Object.hasOwn(SEARCH_SYNONYMS, key) ? SEARCH_SYNONYMS[key] : null;
    let alternatives: string[] = [];
    let prefix = false;
    if (!synonym && /^\p{Script=Latin}{3,}$/u.test(key)) {
      let terms = memo.get(key);
      if (!terms && lookups < 3) {
        terms = await lookup(key);
        memo.set(key, terms);
        lookups++;
      }
      if (terms) {
        prefix = !terms.literal && !hasProtected && index === tokens.length - 1 && terms.prefix;
        if (!prefix && !terms.literal && [...key].length >= 5) {
          const maximum = [...key].length >= 8 ? 2 : 1;
          const candidates = [...new Set(terms.candidates)]
            .map((term) => ({ term, distance: optimalStringAlignment(key, term) }))
            .filter(({ distance }) => distance <= maximum);
          const minimum = Math.min(...candidates.map(({ distance }) => distance));
          const closest = candidates
            .filter(({ distance }) => distance === minimum)
            .map(({ term }) => term)
            .sort();
          if (closest.length <= 3) alternatives = closest;
        }
      }
    }
    if (prefix || alternatives.length > 0) rewrites++;
    if (rewrites > 2) return null;
    const group = (simpleQuery: boolean) => {
      const original = expression(key, simpleQuery);
      const choices = [
        original,
        ...(synonym ? [`(${expression(synonym, simpleQuery)})`] : []),
        ...alternatives.map((value) => expression(value, simpleQuery)),
        ...(prefix ? [`${key}:*`] : []),
      ];
      return `(${choices.join(" | ")})`;
    };
    english.push(group(false));
    simple.push(group(true));
  }
  return rewrites === 0 ? null : { english: english.join(" & "), simple: simple.join(" & "), expanded: true };
}

export function optimalStringAlignment(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

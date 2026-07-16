// CJK scripts (Han, Hiragana, Katakana, Hangul, and the fullwidth/halfwidth
// katakana block) have no whitespace word boundaries, so Postgres' `simple`
// text-search config emits one token for an entire contiguous run. That makes
// only a whole-run match work and breaks native substring search (a query for
// `リザード` never matches the indexed token `リザードン`). Discovery does not
// have pg_bigm/pgroonga available, so substring searchability is produced in
// application code by indexing overlapping character bigrams for each CJK run as
// separate `simple` tokens, and querying those bigrams.
const CJK_CLASS = "　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯";
const CJK_RUN_PATTERN = new RegExp(`[${CJK_CLASS}]+`, "gu");
const HAS_CJK_PATTERN = new RegExp(`[${CJK_CLASS}]`, "u");

/**
 * Maximum search-text size accepted by Discovery's public search routes.
 * Bounding Unicode code points here also bounds CJK bigram expansion downstream.
 */
export const DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS = 256;
export const DISCOVERY_SEARCH_SUGGESTION_QUERY_MAX_CODE_POINTS = 80;

export function truncateDiscoverySearchQuery(value: string): string {
  return [...value].slice(0, DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS).join("");
}

export function truncateDiscoverySearchSuggestionQuery(value: string): string {
  return [...value].slice(0, DISCOVERY_SEARCH_SUGGESTION_QUERY_MAX_CODE_POINTS).join("");
}

/**
 * Removes combining marks from Latin letters while preserving marks used by
 * other scripts, including Japanese dakuten and handakuten.
 */
export function foldSearchDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC");
}

export function normalizeSimpleSearchText(value: string): string {
  return foldSearchDiacritics(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Builds the `simple` tsvector input for INDEXED text: the normalized text plus,
 * for every contiguous CJK run, overlapping character bigrams (and the single
 * character for one-character runs). The original whole run is kept so a
 * whole-run native query still matches; the bigrams enable substring matching.
 */
export function buildSimpleSearchText(value: string): string {
  const normalized = normalizeSimpleSearchText(value);
  const ngrams = cjkSearchNgrams(normalized);
  return ngrams.length > 0 ? `${normalized} ${ngrams.join(" ")}` : normalized;
}

/**
 * Builds the `simple` tsquery input for a QUERY string. Latin runs are kept
 * verbatim, but each CJK run is replaced by its bigrams only (the whole-run
 * token is dropped). A substring query's whole-run token does not exist in the
 * index, so including it would AND a missing lexeme and never match; the bigrams
 * are always a subset of the indexed bigrams, so substring and whole-run native
 * queries both match.
 */
export function buildSimpleSearchQuery(value: string): string {
  const normalized = normalizeSimpleSearchText(value);
  if (!HAS_CJK_PATTERN.test(normalized)) {
    return normalized;
  }

  // Replace each CJK run with its bigrams (or the single char for length-1 runs).
  return normalized
    .replace(CJK_RUN_PATTERN, (run) => runNgrams([...run]).join(" "))
    .replace(/\s+/g, " ")
    .trim();
}

function cjkSearchNgrams(value: string): string[] {
  const ngrams: string[] = [];
  for (const match of value.matchAll(CJK_RUN_PATTERN)) {
    ngrams.push(...runNgrams([...match[0]]));
  }

  return ngrams;
}

function runNgrams(run: readonly string[]): string[] {
  if (run.length === 1) {
    return [run[0]];
  }

  const ngrams: string[] = [];
  for (let index = 0; index < run.length - 1; index += 1) {
    ngrams.push(`${run[index]}${run[index + 1]}`);
  }

  return ngrams;
}

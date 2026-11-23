import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { normalizeSimpleSearchText } from "./normalization";
import { tokenizeSearchText } from "./protected-search-tokens";

/**
 * The Query Vocabulary: the buyer shorthand a search word may stand for, each
 * one a Query-Vocabulary Expansion. Discovery owns it and is its only consumer;
 * operators revise it through the Policy Console. These are query alternatives,
 * not Catalog aliases.
 */
export type QueryVocabulary = Readonly<{
  /** One search word, as the tokenizer normalizes it, to the phrase searched alongside it. */
  expansions: Readonly<Record<string, string>>;
}>;

/** For a read that sends no search text, so it has no word to expand. */
export const EMPTY_QUERY_VOCABULARY: QueryVocabulary = { expansions: {} };

// Reviewed buyer vocabulary: sealed-product abbreviations, franchise shorthand,
// and the Charizard nickname.
const defaultQueryVocabulary: QueryVocabulary = {
  expansions: {
    etb: "elite trainer box",
    bb: "booster box",
    pkmn: "pokemon",
    zard: "charizard",
    ygo: "yu-gi-oh",
  },
};

const MAX_QUERY_VOCABULARY_ENTRIES = 200;
const MAX_QUERY_VOCABULARY_WORD_LENGTH = 32;
const MAX_QUERY_VOCABULARY_EXPANSION_WORDS = 6;

export class QueryVocabularyPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryVocabularyPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A key expands only when it is exactly what the search tokenizer produces for
 * one unprotected word: a looser rule would save a key no search word can match.
 * A word that carries a digit is always protected, so it never expands.
 */
function isQueryVocabularyKey(key: string): boolean {
  const tokens = tokenizeSearchText(key);
  return (
    tokens.length === 1 &&
    tokens[0].raw === key &&
    !tokens[0].digitBearing &&
    normalizeSimpleSearchText(key).toLowerCase() === key
  );
}

function decodeExpansion(key: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new QueryVocabularyPolicyError(`The expansion of '${key}' must be text.`);
  }
  const words = normalizeSimpleSearchText(value).toLowerCase().split(" ").filter(Boolean);
  if (words.length === 0) {
    throw new QueryVocabularyPolicyError(`The expansion of '${key}' must have at least one word.`);
  }
  if (words.length > MAX_QUERY_VOCABULARY_EXPANSION_WORDS) {
    throw new QueryVocabularyPolicyError(
      `The expansion of '${key}' must be at most ${MAX_QUERY_VOCABULARY_EXPANSION_WORDS} words.`,
    );
  }
  if (words.some((word) => [...word].length > MAX_QUERY_VOCABULARY_WORD_LENGTH)) {
    throw new QueryVocabularyPolicyError(
      `Each word in the expansion of '${key}' must be at most ${MAX_QUERY_VOCABULARY_WORD_LENGTH} characters.`,
    );
  }
  if (words.join(" ") === key) {
    throw new QueryVocabularyPolicyError(`The expansion of '${key}' must differ from '${key}'.`);
  }
  return value.trim();
}

export function decodeQueryVocabulary(raw: JsonValue): QueryVocabulary {
  if (!isRecord(raw)) {
    throw new QueryVocabularyPolicyError("Query Vocabulary must be an object.");
  }
  const unknownKey = Object.keys(raw).find((key) => key !== "expansions");
  if (unknownKey !== undefined) {
    throw new QueryVocabularyPolicyError(`Query Vocabulary does not accept ${unknownKey}.`);
  }
  if (!isRecord(raw.expansions)) {
    throw new QueryVocabularyPolicyError("Query Vocabulary expansions must be an object of key to expansion.");
  }
  const entries = Object.entries(raw.expansions);
  if (entries.length > MAX_QUERY_VOCABULARY_ENTRIES) {
    throw new QueryVocabularyPolicyError(
      `Query Vocabulary must have at most ${MAX_QUERY_VOCABULARY_ENTRIES} expansions.`,
    );
  }

  const expansions: Record<string, string> = {};
  for (const [key, value] of entries) {
    if ([...key].length > MAX_QUERY_VOCABULARY_WORD_LENGTH) {
      throw new QueryVocabularyPolicyError(
        `A Query Vocabulary key must be at most ${MAX_QUERY_VOCABULARY_WORD_LENGTH} characters.`,
      );
    }
    if (!isQueryVocabularyKey(key)) {
      throw new QueryVocabularyPolicyError(
        `Query Vocabulary key '${key}' must be one lowercase search word as search normalizes it: letters only, Latin accents removed.`,
      );
    }
    expansions[key] = decodeExpansion(key, value);
  }
  return { expansions };
}

export const queryVocabularyPolicy: PolicyDefinition<QueryVocabulary> = definePolicy({
  policyKey: "discovery.query-vocabulary",
  contextName: "discovery",
  schemaSummary: `{ expansions: { [key: one lowercase search word, at most ${MAX_QUERY_VOCABULARY_WORD_LENGTH} characters]: expansion of 1-${MAX_QUERY_VOCABULARY_EXPANSION_WORDS} words }, at most ${MAX_QUERY_VOCABULARY_ENTRIES} entries }`,
  defaultValue: defaultQueryVocabulary,
  decodeValue: decodeQueryVocabulary,
});

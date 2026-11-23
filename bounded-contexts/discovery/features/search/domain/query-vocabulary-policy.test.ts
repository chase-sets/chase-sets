import { describe, expect, it } from "vitest";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { classifyProtectedSearchTokens } from "./protected-search-tokens";
import {
  decodeQueryVocabulary,
  EMPTY_QUERY_VOCABULARY,
  QueryVocabularyPolicyError,
  queryVocabularyPolicy,
} from "./query-vocabulary-policy";
import { buildSearchSynonymQueries } from "./search-synonyms";

const expansionsOf = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => [
      `key${[...String(index)].map((digit) => "abcdefghij"[Number(digit)]).join("")}`,
      "squirtle",
    ]),
  );

describe("Query Vocabulary policy", () => {
  it("declares the Discovery key and the five expansions in force before the policy existed", () => {
    expect(queryVocabularyPolicy.policyKey).toBe("discovery.query-vocabulary");
    expect(queryVocabularyPolicy.contextName).toBe("discovery");
    expect(queryVocabularyPolicy.defaultValue).toEqual({
      expansions: {
        etb: "elite trainer box",
        bb: "booster box",
        pkmn: "pokemon",
        zard: "charizard",
        ygo: "yu-gi-oh",
      },
    });
    expect(queryVocabularyPolicy.schemaSummary).toBe(
      "{ expansions: { [key: one lowercase search word, at most 32 characters]: expansion of 1-6 words }, at most 200 entries }",
    );
    expect(queryVocabularyPolicy.decodeValue).toBe(decodeQueryVocabulary);
  });

  it("decodes its own default after a storage round trip", () => {
    const { defaultValue, decodeValue } = queryVocabularyPolicy;
    expect(decodeValue(encodePolicyValue(defaultValue))).toEqual(defaultValue);
  });

  it("decodes an empty vocabulary, a native-script key and the bounds themselves", () => {
    expect(decodeQueryVocabulary({ expansions: {} })).toEqual(EMPTY_QUERY_VOCABULARY);
    expect(decodeQueryVocabulary({ expansions: { リザードン: "charizard", sq: "  Squirtle  " } })).toEqual({
      expansions: { リザードン: "charizard", sq: "Squirtle" },
    });
    const longestKey = "a".repeat(32);
    expect(decodeQueryVocabulary({ expansions: { [longestKey]: "one two three four five six" } })).toEqual({
      expansions: { [longestKey]: "one two three four five six" },
    });
    expect(Object.keys(decodeQueryVocabulary({ expansions: expansionsOf(200) }).expansions)).toHaveLength(200);
  });

  const keyRule = "must be one lowercase search word as search normalizes it: letters only, Latin accents removed.";
  const rejected: readonly Readonly<{ name: string; value: JsonValue; message: string }>[] = [
    { name: "a value that is not an object", value: ["etb"], message: "Query Vocabulary must be an object." },
    { name: "a null value", value: null, message: "Query Vocabulary must be an object." },
    {
      name: "a missing expansions member",
      value: {},
      message: "Query Vocabulary expansions must be an object of key to expansion.",
    },
    {
      name: "expansions given as a list",
      value: { expansions: [["etb", "elite trainer box"]] },
      message: "Query Vocabulary expansions must be an object of key to expansion.",
    },
    {
      name: "an unknown member",
      value: { expansions: {}, synonyms: {} },
      message: "Query Vocabulary does not accept synonyms.",
    },
    {
      name: "a key of two words",
      value: { expansions: { "elite trainer": "etb" } },
      message: `Query Vocabulary key 'elite trainer' ${keyRule}`,
    },
    {
      name: "a hyphenated key, which the tokenizer splits",
      value: { expansions: { "yu-gi": "yugioh" } },
      message: `Query Vocabulary key 'yu-gi' ${keyRule}`,
    },
    {
      name: "an uppercase key",
      value: { expansions: { ETB: "elite trainer box" } },
      message: `Query Vocabulary key 'ETB' ${keyRule}`,
    },
    {
      name: "an accented key, which search folds before matching",
      value: { expansions: { poké: "pokemon" } },
      message: `Query Vocabulary key 'poké' ${keyRule}`,
    },
    {
      name: "a digit-bearing key, which is always a protected token",
      value: { expansions: { sv1: "scarlet violet" } },
      message: `Query Vocabulary key 'sv1' ${keyRule}`,
    },
    {
      name: "a key with surrounding space",
      value: { expansions: { " etb": "elite trainer box" } },
      message: `Query Vocabulary key ' etb' ${keyRule}`,
    },
    { name: "an empty key", value: { expansions: { "": "pokemon" } }, message: `Query Vocabulary key '' ${keyRule}` },
    {
      name: "a key over 32 characters",
      value: { expansions: { ["a".repeat(33)]: "pokemon" } },
      message: "A Query Vocabulary key must be at most 32 characters.",
    },
    {
      name: "an empty expansion",
      value: { expansions: { etb: "" } },
      message: "The expansion of 'etb' must have at least one word.",
    },
    {
      name: "an expansion of punctuation only",
      value: { expansions: { etb: " -- " } },
      message: "The expansion of 'etb' must have at least one word.",
    },
    {
      name: "an expansion that is not text",
      value: { expansions: { etb: ["elite", "trainer", "box"] } },
      message: "The expansion of 'etb' must be text.",
    },
    {
      name: "an expansion equal to its key",
      value: { expansions: { etb: "ETB" } },
      message: "The expansion of 'etb' must differ from 'etb'.",
    },
    {
      name: "an expansion over 6 words",
      value: { expansions: { etb: "one two three four five six seven" } },
      message: "The expansion of 'etb' must be at most 6 words.",
    },
    {
      name: "a hyphenated expansion that normalizes to over 6 words",
      value: { expansions: { etb: "one-two-three-four five six seven" } },
      message: "The expansion of 'etb' must be at most 6 words.",
    },
    {
      name: "an expansion word over 32 characters",
      value: { expansions: { etb: `elite ${"a".repeat(33)}` } },
      message: "Each word in the expansion of 'etb' must be at most 32 characters.",
    },
    {
      name: "more than 200 entries",
      value: { expansions: expansionsOf(201) },
      message: "Query Vocabulary must have at most 200 expansions.",
    },
  ];

  it.each(rejected)("rejects $name", ({ value, message }) => {
    expect(() => decodeQueryVocabulary(value)).toThrow(QueryVocabularyPolicyError);
    expect(() => decodeQueryVocabulary(value)).toThrow(message);
  });

  it("rejects an invalid entry when it is revised into a stored vocabulary", () => {
    const { decodeValue, defaultValue } = queryVocabularyPolicy;
    const revised = { expansions: { ...defaultValue.expansions, "booster box": "bb" } };
    expect(() => decodeValue(encodePolicyValue(revised))).toThrow(QueryVocabularyPolicyError);
  });

  // The decode rule is no looser than the tokenizer: a key it accepts is the lookup key
  // search derives for that word, so a saved key can always match.
  it.each(["etb", "リザードン", "squirtle", "a".repeat(32)])(
    "accepts only a key a search word matches: %s",
    async (key) => {
      const vocabulary = decodeQueryVocabulary({ expansions: { [key]: "charizard" } });
      const noServedCodes = async () => new Set<string>();
      expect(await classifyProtectedSearchTokens(key, noServedCodes)).toEqual([{ raw: key, protected: false }]);
      expect((await buildSearchSynonymQueries(key, noServedCodes, vocabulary)).expanded).toBe(true);
      expect((await buildSearchSynonymQueries(key.toUpperCase(), noServedCodes, vocabulary)).expanded).toBe(true);
    },
  );
});

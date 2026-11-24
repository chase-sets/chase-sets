import { describe, expect, it, vi } from "vitest";
import { classifyProtectedSearchTokens } from "./protected-search-tokens";
import { EMPTY_QUERY_VOCABULARY, queryVocabularyPolicy } from "./query-vocabulary-policy";
import * as searchSynonyms from "./search-synonyms";
import { buildSearchSynonymQueries } from "./search-synonyms";

const vocabulary = queryVocabularyPolicy.defaultValue;
const noServedCodes = async () => new Set<string>();

describe("query-vocabulary expansion", () => {
  it("keeps no vocabulary of its own", () => {
    expect(Object.keys(searchSynonyms)).toEqual(["buildSearchSynonymQueries"]);
    expect(searchSynonyms).not.toHaveProperty("SEARCH_SYNONYMS");
    expect(searchSynonyms).not.toHaveProperty("isSearchSynonym");
  });

  it("expands exactly the keys of the vocabulary it is given", async () => {
    const squirtle = { expansions: { sq: "squirtle" } };
    expect((await buildSearchSynonymQueries("sq etb", noServedCodes, squirtle)).simple).toBe("(sq | (squirtle)) & etb");
    expect(await buildSearchSynonymQueries("etb sq", noServedCodes, EMPTY_QUERY_VOCABULARY)).toEqual({
      english: "etb sq",
      simple: "etb sq",
      expanded: false,
    });
    // An expansion that contains another key is searched as written, never expanded again.
    const chained = { expansions: { sq: "squirtle etb", etb: "elite trainer box" } };
    expect((await buildSearchSynonymQueries("sq", noServedCodes, chained)).simple).toBe("(sq | (squirtle <-> etb))");
    expect((await buildSearchSynonymQueries("constructor", noServedCodes, squirtle)).expanded).toBe(false);
  });

  it("never expands a protected token, whatever the vocabulary holds", async () => {
    const protectedKeys = { expansions: { sq: "squirtle", zard: "charizard" } };
    const queries = await buildSearchSynonymQueries("sq 4/102 zard4 zard", async () => new Set(["sq"]), protectedKeys);
    expect(queries.simple).toBe("sq & (4 <-> 102) & zard4 & (zard | (charizard))");
    expect(queries.english).toBe("sq & 4/102 & zard4 & (zard | (charizard))");
  });

  it("builds the queries the compiled table built for its five keys", async () => {
    const queries = await buildSearchSynonymQueries("etb bb pkmn zard ygo", noServedCodes, vocabulary);
    const expected =
      "(etb | (elite <-> trainer <-> box)) & (bb | (booster <-> box)) & (pkmn | (pokemon)) & (zard | (charizard)) & (ygo | (yu <-> gi <-> oh))";
    expect(queries).toEqual({ english: expected, simple: expected, expanded: true });
    const prefixed = await buildSearchSynonymQueries("pkmn etb", noServedCodes, vocabulary, true);
    expect(prefixed.simple).toBe("(pkmn | (pokemon)) & (etb:* | (elite <-> trainer <-> box:*))");
  });

  it("protects raw digit-bearing tokens and only served alphabetic codes before number-shaped tokens", async () => {
    const lookup = vi.fn(async () => new Set(["tsp"]));
    const tokens = await classifyProtectedSearchTokens(
      "TSP 136a charzard 4/102 jungel 60 zard 004/102 SV04 zard4",
      lookup,
    );
    expect(lookup).toHaveBeenCalledExactlyOnceWith(["tsp", "charzard", "jungel", "zard"]);
    expect(tokens.filter((token) => token.protected).map((token) => token.raw)).toEqual([
      "TSP",
      "136a",
      "4/102",
      "60",
      "004/102",
      "SV04",
      "zard4",
    ]);
    // Bypass mutant: a parser-shape policy would also protect all three absent names.
    expect(
      tokens.filter((token) => ["charzard", "jungel", "zard"].includes(token.raw)).every((token) => !token.protected),
    ).toBe(true);
  });

  it("skips lookup without candidates and preserves diacritics, CJK, repetitions and literal digits", async () => {
    const lookup = vi.fn(async () => new Set<string>());
    const queries = await buildSearchSynonymQueries("136a pkmn pkmn Pokémon リザード", lookup, vocabulary);
    expect(lookup).not.toHaveBeenCalled();
    expect(queries.english).toBe("136a & (pkmn | (pokemon)) & (pkmn | (pokemon)) & Pokemon & リザード");
    expect(queries.simple).toBe("136a & (pkmn | (pokemon)) & (pkmn | (pokemon)) & Pokemon & リザ & ザー & ード");
  });

  it("keeps served nickname codes literal without suppressing unrelated expansions", async () => {
    const queries = await buildSearchSynonymQueries("zard 4/102 BB", async () => new Set(["zard"]), vocabulary);
    expect(queries.simple).toBe("zard & (4 <-> 102) & (BB | (booster <-> box))");
  });

  it("preserves decomposed Latin and native combining marks before normalization", async () => {
    const queries = await buildSearchSynonymQueries(
      "ETB Pokémon リザード".normalize("NFD"),
      async () => new Set(),
      vocabulary,
    );
    expect(queries.english).toBe("(ETB | (elite <-> trainer <-> box)) & Pokemon & リザード");
    expect(queries.simple).toBe("(ETB | (elite <-> trainer <-> box)) & Pokemon & リザ & ザー & ード");
  });

  it("protects digit-bearing raw input before punctuation normalization and expands nonnumeric compound abbreviations", async () => {
    const lookup = vi.fn(async () => new Set<string>());
    expect(await classifyProtectedSearchTokens("ETB.1 zard!4", lookup)).toEqual([
      { raw: "ETB.1", protected: true },
      { raw: "zard", protected: true },
      { raw: "4", protected: true },
    ]);
    const queries = await buildSearchSynonymQueries("ETB.1 BB", lookup, vocabulary);
    expect(queries.english).toBe("ETB.1 & (BB | (booster <-> box))");
    expect(queries.simple).toBe("(ETB <-> 1) & (BB | (booster <-> box))");
    expect(lookup).not.toHaveBeenCalled();
    expect((await buildSearchSynonymQueries("pkmn/BB", lookup, vocabulary)).simple).toBe(
      "(pkmn | (pokemon)) & (BB | (booster <-> box))",
    );
  });
});

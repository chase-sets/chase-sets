import { describe, expect, it, vi } from "vitest";
import { classifyProtectedSearchTokens } from "./protected-search-tokens";
import { buildSearchSynonymQueries, isSearchSynonym, SEARCH_SYNONYMS } from "./search-synonyms";

describe("reviewed search vocabulary", () => {
  it("contains only the five justified, non-recursive abbreviations and nicknames", () => {
    expect(SEARCH_SYNONYMS).toEqual({
      etb: "elite trainer box",
      bb: "booster box",
      pkmn: "pokemon",
      zard: "charizard",
      ygo: "yu-gi-oh",
    });
    expect(Object.keys(SEARCH_SYNONYMS).length).toBeLessThanOrEqual(40);
    for (const key of Object.keys(SEARCH_SYNONYMS)) expect(isSearchSynonym(key.toUpperCase())).toBe(true);
    for (const value of Object.values(SEARCH_SYNONYMS)) expect(isSearchSynonym(value)).toBe(false);
    expect(isSearchSynonym("constructor")).toBe(false);
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
    const queries = await buildSearchSynonymQueries("136a pkmn pkmn Pokémon リザード", lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(queries.english).toBe("136a & (pkmn | (pokemon)) & (pkmn | (pokemon)) & Pokemon & リザード");
    expect(queries.simple).toBe("136a & (pkmn | (pokemon)) & (pkmn | (pokemon)) & Pokemon & リザ & ザー & ード");
  });

  it("keeps served nickname codes literal without suppressing unrelated expansions", async () => {
    const queries = await buildSearchSynonymQueries("zard 4/102 BB", async () => new Set(["zard"]));
    expect(queries.simple).toBe("zard & (4 <-> 102) & (BB | (booster <-> box))");
  });

  it("preserves decomposed Latin and native combining marks before normalization", async () => {
    const queries = await buildSearchSynonymQueries("ETB Pokémon リザード".normalize("NFD"), async () => new Set());
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
    const queries = await buildSearchSynonymQueries("ETB.1 BB", lookup);
    expect(queries.english).toBe("ETB.1 & (BB | (booster <-> box))");
    expect(queries.simple).toBe("(ETB <-> 1) & (BB | (booster <-> box))");
    expect(lookup).not.toHaveBeenCalled();
    expect((await buildSearchSynonymQueries("pkmn/BB", lookup)).simple).toBe(
      "(pkmn | (pokemon)) & (BB | (booster <-> box))",
    );
  });
});

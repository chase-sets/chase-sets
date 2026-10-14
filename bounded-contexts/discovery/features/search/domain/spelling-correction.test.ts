import { describe, expect, it, vi } from "vitest";
import { classifyProtectedSearchTokens } from "./protected-search-tokens";
import {
  buildSpellingCorrectionQueries,
  optimalStringAlignment,
  protectedSearchQuery,
  type SearchCorrectionTerms,
} from "./spelling-correction";

const absent = { literal: false, prefix: false, candidates: [] };
async function correction(
  value: string,
  vocabulary: Record<string, Partial<SearchCorrectionTerms>>,
  codes: string[] = [],
) {
  const tokens = await classifyProtectedSearchTokens(value, async () => new Set(codes));
  const lookup = vi.fn(async (key: string) => ({ ...absent, ...vocabulary[key] }));
  return { queries: await buildSpellingCorrectionQueries(tokens, lookup), lookup };
}

describe("required-group spelling correction", () => {
  it.each([
    ["chraizard", "charizard", 1],
    ["charzard", "charizard", 1],
    ["jungel", "jungle", 1],
    ["ca", "abc", 3],
    ["", "abc", 3],
  ])("OSA %s -> %s is %i", (left, right, distance) => expect(optimalStringAlignment(left, right)).toBe(distance));
  it("retains every group, nickname phrase, protected order, padding and suffix", async () => {
    const { queries } = await correction("zard jungel 004/102 136a", { jungel: { candidates: ["jungle"] } });
    expect(queries?.simple).toBe("(zard | (charizard)) & (jungel | jungle) & ((004 <-> 102) | (4 <-> 102)) & (136a)");
    const tokens = await classifyProtectedSearchTokens("TSP 136a OP01-001 TG05 102/4", async () => new Set(["tsp"]));
    expect(protectedSearchQuery(tokens)).toBe(
      "(tsp) & (136a) & ((op01 <-> 001) | (op01 <-> 1)) & (tg05) & (102 <-> 4)",
    );
  });
  it("uses literal vocabulary and synonym keys, never short or non-Latin fuzz", async () => {
    const { queries, lookup } = await correction("zard abcd リザード pokemon charzard 4/102", {
      abcd: { candidates: ["abcde"] },
      pokemon: { literal: true, candidates: ["pokeman"] },
      charzard: { candidates: ["charizard"] },
    });
    expect(queries?.simple).toContain("(abcd) & (リザ <-> ザー <-> ード) & (pokemon) & (charzard | charizard)");
    expect(lookup.mock.calls.map(([key]) => key)).toEqual(["abcd", "pokemon", "charzard"]);
  });
  it("allows a final vocabulary prefix without protected parts, retaining the original", async () => {
    expect(
      (await correction("pikachu char", { pikachu: { literal: true }, char: { prefix: true } })).queries?.simple,
    ).toBe("(pikachu) & (char | char:*)");
    expect((await correction("char 4/102", { char: { prefix: true } })).queries).toBeNull();
    expect((await correction("char", { char: { literal: true, prefix: true } })).queries).toBeNull();
  });
  it("applies length limits, distinct minimum-distance ties and the ambiguity cutoff", async () => {
    expect((await correction("abcde", { abcde: { candidates: ["abcfg"] } })).queries).toBeNull();
    expect(
      (await correction("abcdefgh", { abcdefgh: { candidates: ["abczefgx", "abczefgy", "abczefgx"] } })).queries
        ?.simple,
    ).toBe("(abcdefgh | abczefgx | abczefgy)");
    expect(
      (await correction("abcde", { abcde: { candidates: ["abcdf", "abcdg", "abcdh", "abcdi"] } })).queries,
    ).toBeNull();
    expect((await correction("abcdefgh", { abcdefgh: { candidates: ["abcdefgx", "abczefgx"] } })).queries?.simple).toBe(
      "(abcdefgh | abcdefgx)",
    );
  });
  it("caps lookups at three, memoizes repetitions, and rejects more than two rewrites", async () => {
    const vocabulary = Object.fromEntries(
      ["alpha", "bravo", "charlie", "delta"].map((key) => [key, { candidates: [`${key}x`] }]),
    );
    const over = await correction("alpha bravo charlie delta", vocabulary);
    expect(over.queries).toBeNull();
    expect(over.lookup).toHaveBeenCalledTimes(3);
    const repeated = await correction("alpha alpha", vocabulary);
    expect(repeated.lookup).toHaveBeenCalledTimes(1);
    expect(repeated.queries?.simple).toBe("(alpha | alphax) & (alpha | alphax)");
  });
  it("keeps protected served codes out of all lookups while absent name shapes can correct", async () => {
    expect((await correction("TSP 136a", { tsp: { candidates: ["tspx"] } }, ["tsp"])).lookup).not.toHaveBeenCalled();
    expect((await correction("charzard 4/102", { charzard: { candidates: ["charizard"] } })).queries?.simple).toBe(
      "(charzard | charizard) & (4 <-> 102)",
    );
  });
});

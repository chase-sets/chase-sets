import { describe, expect, it } from "vitest";
import {
  buildSimpleSearchQuery,
  buildSimpleSearchText,
  DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS,
  normalizeSimpleSearchText,
  truncateDiscoverySearchQuery,
} from "./normalization";

describe("discovery search normalization", () => {
  it("keeps letters and numbers while collapsing punctuation and whitespace", () => {
    expect(normalizeSimpleSearchText("  Charizard--ex  199/165!!! ")).toBe("Charizard ex 199 165");
  });
});

describe("CJK n-gram simple search text", () => {
  it("leaves Latin text untouched (no n-grams appended)", () => {
    expect(buildSimpleSearchText("Charizard ex")).toBe("Charizard ex");
  });

  it("appends overlapping bigrams for a kana run so substring search works", () => {
    // リザードン (Charizard, ja). The whole run is one `simple` token; the
    // bigrams let a substring query match under the stock `simple` config.
    expect(buildSimpleSearchText("リザードン")).toBe("リザードン リザ ザー ード ドン");
  });

  it("emits the single character for a one-character CJK run", () => {
    expect(buildSimpleSearchText("火")).toBe("火 火");
  });

  it("handles mixed Latin and CJK, keeping the Latin run intact", () => {
    expect(buildSimpleSearchText("Charizard リザードン")).toBe("Charizard リザードン リザ ザー ード ドン");
  });

  it("produces a substring query whose bigrams are a subset of the indexed bigrams", () => {
    const indexed = buildSimpleSearchText("リザードン").split(" ");
    const query = buildSimpleSearchQuery("リザード").split(" ");
    for (const bigram of query) {
      expect(indexed).toContain(bigram);
    }
  });
});

describe("buildSimpleSearchQuery", () => {
  it("keeps Latin queries verbatim", () => {
    expect(buildSimpleSearchQuery("Charizard ex")).toBe("Charizard ex");
  });

  it("drops the whole CJK run and queries only bigrams so substrings match", () => {
    // A substring's whole-run token is absent from the index, so the query must
    // not include it; bigrams are always a subset of the indexed bigrams.
    expect(buildSimpleSearchQuery("サボネ")).toBe("サボ ボネ");
    expect(buildSimpleSearchQuery("サボネア")).toBe("サボ ボネ ネア");
  });

  it("keeps a single CJK character queryable", () => {
    expect(buildSimpleSearchQuery("火")).toBe("火");
  });

  it("mixes Latin words and CJK bigrams", () => {
    expect(buildSimpleSearchQuery("Charizard リザード")).toBe("Charizard リザ ザー ード");
  });

  it("keeps a maximum-length CJK query's bigram expansion bounded", () => {
    const search = truncateDiscoverySearchQuery("検索".repeat(2_500));
    const queryTokens = buildSimpleSearchQuery(search).split(" ");

    expect([...search]).toHaveLength(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS);
    expect(queryTokens).toHaveLength(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS - 1);
    expect(queryTokens.every((token) => [...token].length === 2)).toBe(true);
  });

  it("normalizes tsquery metacharacters into well-formed simple-search input", () => {
    expect(buildSimpleSearchQuery(`Charizard' & :* "quoted"`)).toBe("Charizard quoted");
  });
});

describe("truncateDiscoverySearchQuery", () => {
  it.each(["a".repeat(10_000), "検索".repeat(2_500)])("truncates oversized input by Unicode code point", (search) => {
    expect([...truncateDiscoverySearchQuery(search)]).toHaveLength(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS);
  });
});

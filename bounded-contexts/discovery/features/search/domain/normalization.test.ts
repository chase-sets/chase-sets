import { describe, expect, it } from "vitest";
import { buildSimpleSearchQuery, buildSimpleSearchText, normalizeSimpleSearchText } from "./normalization";

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
});

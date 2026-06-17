import { describe, expect, it } from "vitest";
import { composeDisplayWithNativeSecondary, selectDisplayAlias } from "./display-alias-policy";

type Candidate = Parameters<typeof selectDisplayAlias>[0][number];

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    aliasText: "Cacnea",
    normalizedAliasText: "cacnea",
    aliasLanguageCode: "en",
    aliasType: "official-equivalent",
    confidence: "high",
    ...overrides,
  };
}

describe("selectDisplayAlias", () => {
  it("selects an accepted English official equivalent as the display name", () => {
    expect(selectDisplayAlias([candidate()])).toMatchObject({ aliasText: "Cacnea", aliasType: "official-equivalent" });
  });

  it("prefers an official equivalent over a non-official high-confidence English alias", () => {
    const chosen = selectDisplayAlias([
      candidate({ aliasText: "Cactus Card", aliasType: "literal-translation", confidence: "exact" }),
      candidate({ aliasText: "Cacnea", aliasType: "official-equivalent", confidence: "high" }),
    ]);
    expect(chosen?.aliasText).toBe("Cacnea");
  });

  it("falls back to a high-confidence English alias when there is no official equivalent", () => {
    const chosen = selectDisplayAlias([
      candidate({ aliasText: "Cactus Pokemon", aliasType: "literal-translation", confidence: "high" }),
    ]);
    expect(chosen?.aliasText).toBe("Cactus Pokemon");
  });

  it("never surfaces generated, species, or romanization aliases as the display name", () => {
    for (const aliasType of ["generated-translation", "species-name", "romanization"]) {
      expect(selectDisplayAlias([candidate({ aliasType, confidence: "exact" })])).toBeNull();
    }
  });

  it("excludes low-trust (generated/candidate) confidence from display even for allowed types", () => {
    expect(selectDisplayAlias([candidate({ confidence: "generated" })])).toBeNull();
    expect(selectDisplayAlias([candidate({ confidence: "candidate" })])).toBeNull();
  });

  it("never surfaces a non-English alias as the English display name", () => {
    expect(selectDisplayAlias([candidate({ aliasLanguageCode: "ja", aliasText: "サボネア" })])).toBeNull();
    expect(selectDisplayAlias([candidate({ aliasLanguageCode: "fr", aliasText: "Cacturne" })])).toBeNull();
  });

  it("treats region-tagged English (en-US) as English", () => {
    expect(selectDisplayAlias([candidate({ aliasLanguageCode: "en-US" })])?.aliasText).toBe("Cacnea");
  });

  it("ranks by confidence then deterministic text when type is equal", () => {
    const chosen = selectDisplayAlias([
      candidate({ aliasText: "Beta", confidence: "high" }),
      candidate({ aliasText: "Alpha", confidence: "exact" }),
    ]);
    // exact outranks high regardless of text order.
    expect(chosen?.aliasText).toBe("Alpha");
  });

  it("returns null for an empty publishable set", () => {
    expect(selectDisplayAlias([])).toBeNull();
  });
});

describe("composeDisplayWithNativeSecondary", () => {
  it("keeps the native name as secondary in parentheses", () => {
    expect(composeDisplayWithNativeSecondary("Cacnea", "サボネア")).toBe("Cacnea (サボネア)");
  });

  it("does not duplicate when alias and native name match", () => {
    expect(composeDisplayWithNativeSecondary("Cacnea", "Cacnea")).toBe("Cacnea");
  });

  it("falls back to the native name when there is no display alias", () => {
    expect(composeDisplayWithNativeSecondary("", "サボネア")).toBe("サボネア");
  });

  it("uses only the alias when there is no native name", () => {
    expect(composeDisplayWithNativeSecondary("Cacnea", "")).toBe("Cacnea");
  });
});

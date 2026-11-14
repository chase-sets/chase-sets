import { describe, expect, it } from "vitest";
import { computeCanonicalScopeRecordProposalId, normalizeScopeMatchKey } from "./scope-record-proposal-store";

describe("Canonical Scope Record proposal identity", () => {
  it("normalizes provider code punctuation into one proposal identity", () => {
    const withPunctuation = computeCanonicalScopeRecordProposalId({
      productDomain: "one-piece",
      scopeKind: "set",
      name: "Romance Dawn",
      officialSetCode: "OP-01",
      languageEditions: ["en"],
    });
    const withoutPunctuation = computeCanonicalScopeRecordProposalId({
      productDomain: "one-piece",
      scopeKind: "set",
      name: "Romance Dawn",
      officialSetCode: "OP01",
      languageEditions: ["en"],
    });

    expect(withPunctuation).toBe(withoutPunctuation);
  });

  it("normalizes case, accents, and punctuation for exact name matching", () => {
    expect(normalizeScopeMatchKey("Pokémon—151")).toBe("pokemon 151");
  });

  it("keeps an English proposal's identity and gives a Japanese edition of the same code its own", () => {
    const english = { productDomain: "pokemon", scopeKind: "expansion", officialSetCode: null } as const;
    expect(
      computeCanonicalScopeRecordProposalId({ ...english, name: "Journey Together", languageEditions: ["en"] }),
    ).toBe("7bae009473e1da3490ddd7dbd1a0cae6943993fa6d32ff0eac50a223780cb826");
    expect(computeCanonicalScopeRecordProposalId({ ...english, name: "Journey Together", languageEditions: [] })).toBe(
      "7bae009473e1da3490ddd7dbd1a0cae6943993fa6d32ff0eac50a223780cb826",
    );

    const flashfire = computeCanonicalScopeRecordProposalId({
      ...english,
      name: "Flashfire",
      officialSetCode: "xy2",
      languageEditions: ["en"],
    });
    const wildBlaze = computeCanonicalScopeRecordProposalId({
      ...english,
      name: "ワイルドブレイズ",
      officialSetCode: "XY2",
      languageEditions: ["ja"],
    });
    expect(wildBlaze).not.toBe(flashfire);
    expect(
      computeCanonicalScopeRecordProposalId({
        ...english,
        name: "ワイルドブレイズ",
        officialSetCode: "XY2",
        languageEditions: [" JA "],
      }),
    ).toBe(wildBlaze);
  });
});

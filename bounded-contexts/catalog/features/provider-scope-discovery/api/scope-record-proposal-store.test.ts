import { describe, expect, it } from "vitest";
import { computeCanonicalScopeRecordProposalId, normalizeScopeMatchKey } from "./scope-record-proposal-store";

describe("Canonical Scope Record proposal identity", () => {
  it("normalizes provider code punctuation into one proposal identity", () => {
    const withPunctuation = computeCanonicalScopeRecordProposalId({
      productDomain: "one-piece",
      scopeKind: "set",
      name: "Romance Dawn",
      officialSetCode: "OP-01",
    });
    const withoutPunctuation = computeCanonicalScopeRecordProposalId({
      productDomain: "one-piece",
      scopeKind: "set",
      name: "Romance Dawn",
      officialSetCode: "OP01",
    });

    expect(withPunctuation).toBe(withoutPunctuation);
  });

  it("normalizes case, accents, and punctuation for exact name matching", () => {
    expect(normalizeScopeMatchKey("Pokémon—151")).toBe("pokemon 151");
  });
});

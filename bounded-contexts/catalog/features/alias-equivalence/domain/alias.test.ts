import { describe, expect, it } from "vitest";
import {
  buildCatalogAliasCandidate,
  computeCatalogAliasHash,
  catalogAliasIdentity,
  dedupeCatalogAliasCandidates,
  isCatalogAliasPublishable,
  isReferenceRecordAliasType,
  normalizeAliasText,
  type BuildCatalogAliasCandidateInput,
} from "./alias";

function candidateInput(overrides: Partial<BuildCatalogAliasCandidateInput> = {}): BuildCatalogAliasCandidateInput {
  return {
    target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
    aliasText: "Dracaufeu",
    aliasLanguageCode: "fr",
    sourceLanguageCode: "en",
    aliasType: "official-equivalent",
    confidence: "high",
    reviewStatus: "pending",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_1",
      sourceCategory: "provider-same-id-localized-endpoint",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fp-1",
    },
    evidence: { sharedId: "base1-4" },
    ...overrides,
  };
}

describe("alias normalization", () => {
  it("trims, collapses whitespace, and lowercases", () => {
    expect(normalizeAliasText("  Pikachu   VMAX ")).toBe("pikachu vmax");
  });

  it("normalizes provider key and language codes when building a candidate", () => {
    const candidate = buildCatalogAliasCandidate(
      candidateInput({
        aliasText: "  Dracaufeu ",
        aliasLanguageCode: "FR",
        provenance: { ...candidateInput().provenance, providerKey: "TCGdex" },
      }),
    );

    expect(candidate.aliasText).toBe("Dracaufeu");
    expect(candidate.normalizedAliasText).toBe("dracaufeu");
    expect(candidate.aliasLanguageCode).toBe("fr");
    expect(candidate.provenance.providerKey).toBe("tcgdex");
  });
});

describe("alias hashing and dedupe", () => {
  it("computes a stable deterministic hash for the identity tuple", () => {
    const first = buildCatalogAliasCandidate(candidateInput());
    const second = buildCatalogAliasCandidate(candidateInput({ evidence: { sharedId: "different" } }));

    // Evidence is intentionally outside identity: same claim, same hash.
    expect(first.aliasHash).toBe(second.aliasHash);
  });

  it("changes the hash when the normalized identity changes", () => {
    const base = buildCatalogAliasCandidate(candidateInput());
    const otherLanguage = buildCatalogAliasCandidate(candidateInput({ aliasLanguageCode: "de" }));
    const otherType = buildCatalogAliasCandidate(
      candidateInput({
        aliasType: "literal-translation",
        provenance: { ...candidateInput().provenance, sourceCategory: "machine-translation" },
        confidence: "generated",
      }),
    );

    expect(otherLanguage.aliasHash).not.toBe(base.aliasHash);
    expect(otherType.aliasHash).not.toBe(base.aliasHash);
  });

  it("treats different alias text variants that normalize the same as one identity", () => {
    const lower = computeCatalogAliasHash(
      catalogAliasIdentity({
        target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
        normalizedAliasText: normalizeAliasText("Pikachu"),
        aliasLanguageCode: "en",
        aliasType: "species-name",
        provenance: { providerKey: "tcgdex", sourceCategory: "species-reference" },
      }),
    );
    const spaced = computeCatalogAliasHash(
      catalogAliasIdentity({
        target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
        normalizedAliasText: normalizeAliasText("  pikachu "),
        aliasLanguageCode: "en",
        aliasType: "species-name",
        provenance: { providerKey: "tcgdex", sourceCategory: "species-reference" },
      }),
    );

    expect(lower).toBe(spaced);
  });

  it("dedupes a candidate list by hash keeping the last (freshest) evidence", () => {
    const stale = buildCatalogAliasCandidate(candidateInput({ evidence: { rev: 1 } }));
    const fresh = buildCatalogAliasCandidate(candidateInput({ evidence: { rev: 2 } }));
    const other = buildCatalogAliasCandidate(candidateInput({ aliasLanguageCode: "de" }));

    const deduped = dedupeCatalogAliasCandidates([stale, fresh, other]);

    expect(deduped).toHaveLength(2);
    const survivor = deduped.find((entry) => entry.aliasHash === fresh.aliasHash);
    expect(survivor?.evidence).toEqual({ rev: 2 });
  });
});

describe("alias cardinality (many-to-many)", () => {
  it("lets one alias text map to many Catalog Items with distinct hashes", () => {
    const pikachuA = buildCatalogAliasCandidate(
      candidateInput({
        target: { kind: "catalog-item", targetId: "cat_a", targetKey: "name" },
        aliasText: "Pikachu",
        aliasType: "species-name",
        provenance: { ...candidateInput().provenance, sourceCategory: "species-reference" },
      }),
    );
    const pikachuB = buildCatalogAliasCandidate(
      candidateInput({
        target: { kind: "catalog-item", targetId: "cat_b", targetKey: "name" },
        aliasText: "Pikachu",
        aliasType: "species-name",
        provenance: { ...candidateInput().provenance, sourceCategory: "species-reference" },
      }),
    );

    expect(pikachuA.aliasHash).not.toBe(pikachuB.aliasHash);
    expect(pikachuA.normalizedAliasText).toBe(pikachuB.normalizedAliasText);
  });

  it("lets one Catalog Item carry many aliases across languages and types", () => {
    const fr = buildCatalogAliasCandidate(candidateInput({ aliasText: "Dracaufeu", aliasLanguageCode: "fr" }));
    const de = buildCatalogAliasCandidate(candidateInput({ aliasText: "Glurak", aliasLanguageCode: "de" }));

    expect(fr.target.targetId).toBe(de.target.targetId);
    expect(fr.aliasHash).not.toBe(de.aliasHash);
  });
});

describe("alias target-level enforcement", () => {
  it("requires reference-record alias types to target a reference record", () => {
    expect(isReferenceRecordAliasType("set-equivalent")).toBe(true);
    expect(isReferenceRecordAliasType("series-equivalent")).toBe(true);
    expect(isReferenceRecordAliasType("official-equivalent")).toBe(false);

    expect(() =>
      buildCatalogAliasCandidate(
        candidateInput({
          aliasType: "set-equivalent",
          target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
        }),
      ),
    ).toThrow(/does not match target kind/);
  });

  it("builds a reference-record set-equivalent alias", () => {
    const candidate = buildCatalogAliasCandidate(
      candidateInput({
        aliasType: "set-equivalent",
        target: { kind: "reference-record", targetId: "ref_1", targetKey: "expansion" },
        provenance: { ...candidateInput().provenance, sourceCategory: "provider-same-id-localized-endpoint" },
      }),
    );

    expect(candidate.target.kind).toBe("reference-record");
    expect(candidate.target.targetKey).toBe("expansion");
  });

  it("rejects empty alias text and empty target key", () => {
    expect(() => buildCatalogAliasCandidate(candidateInput({ aliasText: "   " }))).toThrow(/non-empty alias text/);
    expect(() =>
      buildCatalogAliasCandidate(
        candidateInput({ target: { kind: "catalog-item", targetId: "cat_1", targetKey: "  " } }),
      ),
    ).toThrow(/target key/);
  });
});

describe("publishable review-state gating", () => {
  it("treats only accepted and auto-accepted as publishable", () => {
    expect(isCatalogAliasPublishable("accepted")).toBe(true);
    expect(isCatalogAliasPublishable("auto-accepted")).toBe(true);
    expect(isCatalogAliasPublishable("pending")).toBe(false);
    expect(isCatalogAliasPublishable("rejected")).toBe(false);
    expect(isCatalogAliasPublishable("revoked")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractTcgdexAliasCandidates,
  hasReliableSpeciesEvidence,
  matchTcgdexEnglishEndpointEntity,
  TCGDEX_ENGLISH_LANGUAGE_CODE,
  TCGDEX_INDONESIAN_LANGUAGE_CODE,
  type TcgdexAliasExtractionInput,
} from "./tcgdex-alias-extraction";
import type { CatalogAliasCandidate } from "../../../alias-equivalence/domain/alias";

function baseInput(overrides: Partial<TcgdexAliasExtractionInput> = {}): TcgdexAliasExtractionInput {
  return {
    sourceLanguageCode: "ja",
    observationId: "tcgdex_ja_sv1a_001_standard",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    mappingFingerprint: "fp-1",
    card: {
      id: "sv1a-001",
      name: "ニャオハ",
      category: "Pokemon",
      dexId: [906],
      catalogItemFieldKey: "card-name",
      catalogItemId: "cat_sprigatito",
    },
    expansion: {
      id: "sv1a",
      name: "トリプレットビート",
      referenceTypeKey: "expansion",
      referenceRecordId: "ref_sv1a",
    },
    series: {
      id: "sv",
      name: "スカーレット&バイオレット",
      referenceTypeKey: "series",
      referenceRecordId: "ref_sv",
    },
    ...overrides,
  };
}

function byType(candidates: readonly CatalogAliasCandidate[], aliasType: string): CatalogAliasCandidate[] {
  return candidates.filter((candidate) => candidate.aliasType === aliasType);
}

describe("matchTcgdexEnglishEndpointEntity", () => {
  it("returns the English name only when the same provider id resolves a matching entity", () => {
    expect(
      matchTcgdexEnglishEndpointEntity({ sourceId: "sv1a-001", englishEntity: { id: "sv1a-001", name: "Sprigatito" } }),
    ).toBe("Sprigatito");
  });

  it("returns null when the English endpoint did not exist (null entity)", () => {
    expect(matchTcgdexEnglishEndpointEntity({ sourceId: "sv1a-001", englishEntity: null })).toBeNull();
  });

  it("returns null when the English entity id does not match the source id", () => {
    expect(
      matchTcgdexEnglishEndpointEntity({ sourceId: "sv1a-001", englishEntity: { id: "sv01-001", name: "Sprigatito" } }),
    ).toBeNull();
  });

  it("returns null when the English entity has an empty name", () => {
    expect(
      matchTcgdexEnglishEndpointEntity({ sourceId: "sv1a-001", englishEntity: { id: "sv1a-001", name: "   " } }),
    ).toBeNull();
  });
});

describe("hasReliableSpeciesEvidence", () => {
  it("is true for a Pokemon card with a dex id", () => {
    expect(
      hasReliableSpeciesEvidence({ id: "x", name: "y", category: "Pokemon", dexId: [25], catalogItemFieldKey: "f" }),
    ).toBe(true);
  });

  it("is false for a Trainer card", () => {
    expect(
      hasReliableSpeciesEvidence({ id: "x", name: "y", category: "Trainer", dexId: [], catalogItemFieldKey: "f" }),
    ).toBe(false);
  });

  it("is false for a Pokemon card with no dex id", () => {
    expect(hasReliableSpeciesEvidence({ id: "x", name: "y", category: "Pokemon", catalogItemFieldKey: "f" })).toBe(
      false,
    );
  });
});

describe("extractTcgdexAliasCandidates - Japanese Pokemon card with English mirror", () => {
  const candidates = extractTcgdexAliasCandidates(
    baseInput({
      englishMatches: {
        card: { id: "sv1a-001", name: "Sprigatito" },
        expansion: { id: "sv1a", name: "Triplet Beat" },
        series: { id: "sv", name: "Scarlet & Violet" },
      },
    }),
  );

  it("preserves the native Japanese card name as a provider-localized-name", () => {
    const localized = byType(candidates, "provider-localized-name");
    expect(localized).toHaveLength(1);
    expect(localized[0]?.aliasText).toBe("ニャオハ");
    expect(localized[0]?.aliasLanguageCode).toBe("ja");
    expect(localized[0]?.provenance.sourceCategory).toBe("provider-localized-name");
    expect(localized[0]?.reviewStatus).toBe("pending");
  });

  it("emits a same-id English official-equivalent at high confidence held for review", () => {
    const official = byType(candidates, "official-equivalent");
    expect(official).toHaveLength(1);
    expect(official[0]?.aliasText).toBe("Sprigatito");
    expect(official[0]?.aliasLanguageCode).toBe(TCGDEX_ENGLISH_LANGUAGE_CODE);
    expect(official[0]?.sourceLanguageCode).toBe("ja");
    expect(official[0]?.confidence).toBe("high");
    expect(official[0]?.provenance.sourceCategory).toBe("provider-same-id-localized-endpoint");
    // #1912: same-id endpoint is strong evidence but never auto-accepted.
    expect(official[0]?.reviewStatus).toBe("pending");
    expect(official[0]?.evidence).toMatchObject({ sharedProviderId: "sv1a-001" });
  });

  it("emits set-equivalent and series-equivalent English aliases from the mirror", () => {
    expect(byType(candidates, "set-equivalent").some((c) => c.aliasText === "Triplet Beat")).toBe(true);
    expect(byType(candidates, "series-equivalent").some((c) => c.aliasText === "Scarlet & Violet")).toBe(true);
  });

  it("emits a species-name alias from dex evidence, never exact card equivalence", () => {
    const species = byType(candidates, "species-name");
    expect(species).toHaveLength(1);
    expect(species[0]?.aliasText).toBe("Sprigatito");
    expect(species[0]?.confidence).toBe("candidate");
    expect(species[0]?.provenance.sourceCategory).toBe("species-reference");
    expect(species[0]?.evidence).toMatchObject({ dexId: [906], evidenceKind: "dex-id" });
  });
});

describe("extractTcgdexAliasCandidates - Japanese set/card with missing English endpoint", () => {
  it("emits only native provider-localized aliases when /en/sets/{id} does not exist", () => {
    const candidates = extractTcgdexAliasCandidates(
      baseInput({
        // No English mirror existed for this Japanese-only set/card.
        englishMatches: { card: null, expansion: null, series: null },
      }),
    );

    expect(byType(candidates, "official-equivalent")).toHaveLength(0);
    expect(byType(candidates, "set-equivalent").every((c) => c.aliasLanguageCode === "ja")).toBe(true);
    expect(byType(candidates, "series-equivalent").every((c) => c.aliasLanguageCode === "ja")).toBe(true);
    // No reliable English species name without an English mirror.
    expect(byType(candidates, "species-name")).toHaveLength(0);
    // Native names are still preserved.
    expect(byType(candidates, "provider-localized-name")).toHaveLength(1);
  });
});

describe("extractTcgdexAliasCandidates - Japanese Trainer card", () => {
  it("never emits a species alias for a Trainer card even with an English mirror", () => {
    const candidates = extractTcgdexAliasCandidates(
      baseInput({
        card: {
          id: "sv1a-200",
          name: "ナンジャモ",
          category: "Trainer",
          dexId: [],
          catalogItemFieldKey: "card-name",
          catalogItemId: "cat_iono",
        },
        englishMatches: {
          card: { id: "sv1a-200", name: "Iono" },
          expansion: { id: "sv1a", name: "Triplet Beat" },
          series: { id: "sv", name: "Scarlet & Violet" },
        },
      }),
    );

    expect(byType(candidates, "species-name")).toHaveLength(0);
    // The same-id English official equivalent still applies (name+set evidence).
    expect(byType(candidates, "official-equivalent")[0]?.aliasText).toBe("Iono");
    expect(byType(candidates, "provider-localized-name")[0]?.aliasText).toBe("ナンジャモ");
  });
});

describe("extractTcgdexAliasCandidates - Indonesian false-friend guard", () => {
  it("marks an Indonesian name as an Indonesian provider-localized-name, never an English alias", () => {
    const candidates = extractTcgdexAliasCandidates(
      baseInput({
        sourceLanguageCode: TCGDEX_INDONESIAN_LANGUAGE_CODE,
        card: {
          // The Indonesian Pokemon species name happens to read like English.
          id: "sv1a-001",
          name: "Sprigatito",
          category: "Pokemon",
          dexId: [906],
          catalogItemFieldKey: "card-name",
          catalogItemId: "cat_sprigatito",
        },
        // Even if an English mirror is supplied, the native Indonesian name must
        // never be promoted to English official truth.
        englishMatches: { card: { id: "sv1a-001", name: "Sprigatito" }, expansion: null, series: null },
      }),
    );

    const localized = byType(candidates, "provider-localized-name");
    expect(localized).toHaveLength(1);
    // The Indonesian name is recorded under the Indonesian language code.
    expect(localized[0]?.aliasText).toBe("Sprigatito");
    expect(localized[0]?.aliasLanguageCode).toBe(TCGDEX_INDONESIAN_LANGUAGE_CODE);
    expect(localized[0]?.provenance.sourceCategory).toBe("provider-localized-name");

    // Crucial: no English alias is sourced FROM the Indonesian `id` text. The
    // only English alias present comes from the English ENDPOINT match, whose
    // alias language is English and whose source category is the same-id
    // endpoint, never `provider-localized-name`.
    for (const candidate of candidates) {
      if (candidate.provenance.sourceCategory === "provider-localized-name") {
        expect(candidate.aliasLanguageCode).toBe(TCGDEX_INDONESIAN_LANGUAGE_CODE);
        expect(candidate.aliasLanguageCode).not.toBe("en");
      }
    }

    // The English official equivalent that exists is backed by the endpoint, and
    // its evidence records that the source language was Indonesian for audit.
    const official = byType(candidates, "official-equivalent");
    expect(official).toHaveLength(1);
    expect(official[0]?.aliasLanguageCode).toBe("en");
    expect(official[0]?.sourceLanguageCode).toBe(TCGDEX_INDONESIAN_LANGUAGE_CODE);
    expect(official[0]?.provenance.sourceCategory).toBe("provider-same-id-localized-endpoint");
    expect(official[0]?.evidence).toMatchObject({ sourceLanguageIsIndonesian: true });
  });

  it("never produces an English-language alias whose source category is provider-localized-name", () => {
    const candidates = extractTcgdexAliasCandidates(
      baseInput({
        sourceLanguageCode: TCGDEX_INDONESIAN_LANGUAGE_CODE,
        card: {
          id: "sv1a-001",
          name: "Pikachu",
          category: "Pokemon",
          dexId: [25],
          catalogItemFieldKey: "card-name",
          catalogItemId: "cat_pikachu",
        },
        englishMatches: { card: null, expansion: null, series: null },
      }),
    );

    const englishFromLocalized = candidates.filter(
      (candidate) =>
        candidate.aliasLanguageCode === "en" && candidate.provenance.sourceCategory === "provider-localized-name",
    );
    expect(englishFromLocalized).toHaveLength(0);
  });
});

describe("extractTcgdexAliasCandidates - determinism", () => {
  it("produces identical hashes on repeat extraction so persistence dedupes", () => {
    const input = baseInput({ englishMatches: { card: { id: "sv1a-001", name: "Sprigatito" } } });
    const first = extractTcgdexAliasCandidates(input).map((c) => c.aliasHash);
    const second = extractTcgdexAliasCandidates(input).map((c) => c.aliasHash);
    expect(second).toEqual(first);
  });
});

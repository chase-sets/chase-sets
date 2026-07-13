import { describe, expect, it, vi } from "vitest";
import {
  assembleCatalogAliasReviewReadModel,
  buildCatalogAliasReviewReadModel,
  catalogAliasReviewContractVersion,
  mapCatalogAliasReviewCandidate,
  summarizeCatalogAliasReviewCounts,
  type CatalogAliasReviewFilter,
} from "./alias-review-admin-contracts";
import type {
  CatalogAliasCandidateRow,
  CatalogItemAliasRow,
  CatalogReferenceRecordAliasRow,
} from "../read-model/queries";

function candidateRow(overrides: Partial<CatalogAliasCandidateRow> = {}): CatalogAliasCandidateRow {
  return {
    alias_hash: "hash_official",
    target_kind: "catalog-item",
    target_id: "cat_charizard",
    target_key: "name",
    alias_text: "Sprigatito",
    normalized_alias_text: "sprigatito",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "pending",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: { providerId: "sv1a-001", evidenceKind: "card-id", nativeName: "ニャオハ" },
    first_observed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function catalogItemAliasRow(overrides: Partial<CatalogItemAliasRow> = {}): CatalogItemAliasRow {
  return {
    alias_hash: "hash_item",
    catalog_item_id: "cat_charizard",
    target_field: "name",
    alias_text: "Sprigatito",
    normalized_alias_text: "sprigatito",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "accepted",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    last_actor: "usr_1",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: "2026-06-16T00:00:00.000Z",
    reviewed_at: "2026-06-16T01:00:00.000Z",
    updated_at: "2026-06-16T01:00:00.000Z",
    ...overrides,
  };
}

function referenceRecordAliasRow(
  overrides: Partial<CatalogReferenceRecordAliasRow> = {},
): CatalogReferenceRecordAliasRow {
  return {
    alias_hash: "hash_ref",
    reference_record_id: "ref_expansion_1",
    type_key: "expansion",
    alias_text: "Triplet Beat",
    normalized_alias_text: "triplet beat",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "set-equivalent",
    confidence: "exact",
    review_status: "auto-accepted",
    provider_key: "tcgdex",
    observation_id: "obs_2",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    last_actor: "system",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: "2026-06-16T00:00:00.000Z",
    reviewed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

const emptyFilter: CatalogAliasReviewFilter = {
  providerKey: null,
  sourceProfileVersion: null,
  aliasType: null,
  reviewStatuses: [],
  observationId: null,
  targetKind: null,
  targetId: null,
};

describe("mapCatalogAliasReviewCandidate", () => {
  it("surfaces native printed name, proposed alias, type, confidence, source, evidence, and status", () => {
    const summary = mapCatalogAliasReviewCandidate(candidateRow());

    expect(summary.proposedAlias).toBe("Sprigatito");
    expect(summary.nativePrintedName).toBe("ニャオハ");
    expect(summary.nativeLanguageCode).toBe("ja");
    expect(summary.aliasType).toBe("official-equivalent");
    expect(summary.confidence).toBe("high");
    expect(summary.providerKey).toBe("tcgdex");
    expect(summary.reviewStatus).toBe("pending");
    expect(summary.evidence.map((line) => line.key)).toContain("providerId");
    expect(summary.evidence.find((line) => line.key === "providerId")?.value).toBe("sv1a-001");
  });

  it("uses the alias text itself as the native printed name for provider-localized names", () => {
    const summary = mapCatalogAliasReviewCandidate(
      candidateRow({
        alias_type: "provider-localized-name",
        alias_text: "ニャオハ",
        alias_language_code: "ja",
        source_category: "provider-localized-name",
        evidence: {},
      }),
    );
    expect(summary.nativePrintedName).toBe("ニャオハ");
    expect(summary.nativeLanguageCode).toBe("ja");
  });

  it("derives auto-accept eligibility from governance and only for pending candidates", () => {
    const curated = mapCatalogAliasReviewCandidate(
      candidateRow({ alias_hash: "h_curated", source_category: "curated-operator-mapping" }),
    );
    expect(curated.autoAccept.governedReviewState).toBe("auto-accepted");
    expect(curated.autoAccept.eligible).toBe(true);
    expect(curated.availableActions).toContain("auto-accept");

    // Same governance, but already accepted: not eligible for the bulk action.
    const accepted = mapCatalogAliasReviewCandidate(
      candidateRow({
        alias_hash: "h_curated2",
        source_category: "curated-operator-mapping",
        review_status: "accepted",
      }),
    );
    expect(accepted.autoAccept.eligible).toBe(false);
    expect(accepted.availableActions).toEqual(["revoke"]);
  });

  it("flags generated translations and low-confidence evidence as warnings", () => {
    const generated = mapCatalogAliasReviewCandidate(
      candidateRow({
        alias_hash: "h_gen",
        alias_type: "generated-translation",
        confidence: "generated",
        source_category: "machine-translation",
      }),
    );
    expect(generated.warnings).toContain("generated-translation");
    expect(generated.warnings).toContain("low-confidence-evidence");
    expect(generated.warnings).toContain("never-official-source");
    expect(generated.autoAccept.eligible).toBe(false);
  });

  it("flags an alias sourced from the Indonesian id language code", () => {
    const indonesian = mapCatalogAliasReviewCandidate(candidateRow({ alias_hash: "h_id", source_language_code: "id" }));
    expect(indonesian.warnings).toContain("indonesian-id-not-english");
  });

  it("offers accept again for a previously rejected or revoked alias", () => {
    expect(mapCatalogAliasReviewCandidate(candidateRow({ review_status: "rejected" })).availableActions).toEqual([
      "accept",
    ]);
    expect(mapCatalogAliasReviewCandidate(candidateRow({ review_status: "revoked" })).availableActions).toEqual([
      "accept",
    ]);
  });
});

describe("summarizeCatalogAliasReviewCounts", () => {
  it("counts review states, needs-review, auto-accept eligibility, and warnings", () => {
    const candidates = [
      mapCatalogAliasReviewCandidate(candidateRow({ alias_hash: "a", source_category: "curated-operator-mapping" })),
      mapCatalogAliasReviewCandidate(candidateRow({ alias_hash: "b", review_status: "accepted" })),
      mapCatalogAliasReviewCandidate(
        candidateRow({ alias_hash: "c", alias_type: "generated-translation", confidence: "generated" }),
      ),
    ];
    const counts = summarizeCatalogAliasReviewCounts(candidates);
    expect(counts.total).toBe(3);
    expect(counts.pending).toBe(2);
    expect(counts.accepted).toBe(1);
    expect(counts.needsReview).toBe(2);
    expect(counts.autoAcceptEligible).toBe(1);
    expect(counts.warned).toBe(1);
  });
});

describe("buildCatalogAliasReviewReadModel", () => {
  it("classifies coverage by accepted English alias, species-only, and needs-review", () => {
    const readModel = buildCatalogAliasReviewReadModel({
      generatedAt: "2026-06-16T00:00:00.000Z",
      filter: emptyFilter,
      candidateRows: [
        candidateRow({ alias_hash: "pending_card", target_id: "cat_needs_review", review_status: "pending" }),
      ],
      catalogItemAliasRows: [
        catalogItemAliasRow({ alias_hash: "english_card", catalog_item_id: "cat_english" }),
        catalogItemAliasRow({
          alias_hash: "species_card",
          catalog_item_id: "cat_species",
          alias_type: "species-name",
          alias_language_code: "en",
        }),
      ],
      referenceRecordAliasRows: [referenceRecordAliasRow()],
    });

    expect(readModel.schemaVersion).toBe(catalogAliasReviewContractVersion);
    expect(readModel.coverage.cardsWithAcceptedEnglishAlias).toBe(1);
    expect(readModel.coverage.cardsWithOnlySpeciesAliases).toBe(1);
    expect(readModel.coverage.cardsNeedingReview).toBe(1);
    const englishCard = readModel.coverage.cards.find((card) => card.catalogItemId === "cat_english");
    expect(englishCard?.state).toBe("accepted-english-alias");
  });

  it("counts pending set/series candidates as expansions and series needing review", () => {
    const readModel = buildCatalogAliasReviewReadModel({
      generatedAt: "2026-06-16T00:00:00.000Z",
      filter: emptyFilter,
      candidateRows: [
        candidateRow({
          alias_hash: "pending_set",
          target_kind: "reference-record",
          target_id: "ref_expansion_pending",
          target_key: "expansion",
          alias_type: "set-equivalent",
          review_status: "pending",
        }),
      ],
      catalogItemAliasRows: [],
      referenceRecordAliasRows: [],
    });
    expect(readModel.coverage.expansionsAndSeriesNeedingReview).toBe(1);
  });

  it("groups candidates by provider, language, and expansion scope", () => {
    const readModel = buildCatalogAliasReviewReadModel({
      generatedAt: "2026-06-16T00:00:00.000Z",
      filter: emptyFilter,
      candidateRows: [
        candidateRow({ alias_hash: "g1" }),
        candidateRow({
          alias_hash: "g2",
          target_kind: "reference-record",
          target_id: "ref_exp_1",
          target_key: "expansion",
          alias_type: "set-equivalent",
        }),
      ],
      catalogItemAliasRows: [],
      referenceRecordAliasRows: [],
    });
    const providerGroups = readModel.groups.filter((group) => group.scope === "provider");
    expect(providerGroups).toHaveLength(1);
    expect(providerGroups[0]?.counts.total).toBe(2);
    expect(readModel.groups.some((group) => group.scope === "expansion" && group.value === "ref_exp_1")).toBe(true);
  });
});

describe("assembleCatalogAliasReviewReadModel", () => {
  it("fetches candidates then the accepted aliases for every distinct target", async () => {
    const services = {
      listSourceObservationAliasCandidates: vi.fn(async () => [
        candidateRow({ alias_hash: "c1", target_id: "cat_a" }),
        candidateRow({
          alias_hash: "c2",
          target_kind: "reference-record" as const,
          target_id: "ref_a",
          target_key: "expansion",
          alias_type: "set-equivalent" as const,
        }),
      ]),
      listCatalogItemAliases: vi.fn(async () => [catalogItemAliasRow({ catalog_item_id: "cat_a" })]),
      listReferenceRecordAliases: vi.fn(async () => [referenceRecordAliasRow({ reference_record_id: "ref_a" })]),
    };

    const readModel = await assembleCatalogAliasReviewReadModel(services, {
      generatedAt: "2026-06-16T00:00:00.000Z",
      filter: { providerKey: "tcgdex" },
    });

    expect(services.listSourceObservationAliasCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "tcgdex" }),
    );
    expect(services.listCatalogItemAliases).toHaveBeenCalledWith("cat_a");
    expect(services.listReferenceRecordAliases).toHaveBeenCalledWith("ref_a");
    expect(readModel.candidates).toHaveLength(2);
    expect(readModel.filter.providerKey).toBe("tcgdex");
  });
});

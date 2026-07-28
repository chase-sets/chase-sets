import { describe, expect, it } from "vitest";
import { buildCatalogAliasCandidate } from "../../../alias-equivalence/domain/alias";
import {
  planPromotionAliases,
  type PromotionAliasCandidate,
  type PromotionAliasProposeAction,
  type PromotionAliasRetractAction,
} from "./provider-promotion-alias-planner";

function itemCandidate(overrides: Partial<PromotionAliasCandidate> = {}): PromotionAliasCandidate {
  return {
    target: { kind: "catalog-item", targetKey: "card-name" },
    aliasText: "Dracaufeu",
    aliasLanguageCode: "fr",
    sourceLanguageCode: "en",
    aliasType: "official-equivalent",
    confidence: "high",
    reviewStatus: "accepted",
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

function referenceCandidate(overrides: Partial<PromotionAliasCandidate> = {}): PromotionAliasCandidate {
  return {
    target: { kind: "reference-record", targetKey: "expansion" },
    aliasText: "Triplet Beat",
    aliasLanguageCode: "en",
    sourceLanguageCode: "ja",
    aliasType: "set-equivalent",
    confidence: "exact",
    reviewStatus: "auto-accepted",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_1",
      sourceCategory: "provider-same-id-localized-endpoint",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fp-1",
    },
    evidence: {},
    ...overrides,
  };
}

const resolution = {
  catalogItemId: "cat_charizard",
  referenceRecordIdsByTypeKey: { expansion: "ref_expansion_1", series: "ref_series_1" },
};

function proposeActions(plan: ReturnType<typeof planPromotionAliases>): PromotionAliasProposeAction[] {
  return plan.actions.filter((action): action is PromotionAliasProposeAction => action.kind === "propose");
}

function retractActions(plan: ReturnType<typeof planPromotionAliases>): PromotionAliasRetractAction[] {
  return plan.actions.filter((action): action is PromotionAliasRetractAction => action.kind === "retract");
}

describe("planPromotionAliases", () => {
  it("resolves the Catalog Item id before building an accepted item alias", () => {
    const plan = planPromotionAliases({ candidates: [itemCandidate()], resolution });

    const actions = proposeActions(plan);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.accept).toBe(true);
    expect(actions[0]?.targetResolved).toBe(true);
    expect(actions[0]?.candidate.target.targetId).toBe("cat_charizard");
    // The durable hash carries the resolved id.
    const expected = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "card-name" },
      aliasText: "Dracaufeu",
      aliasLanguageCode: "fr",
      sourceLanguageCode: "en",
      aliasType: "official-equivalent",
      confidence: "high",
      reviewStatus: "accepted",
      provenance: itemCandidate().provenance,
      evidence: { sharedId: "base1-4" },
    });
    expect(actions[0]?.candidate.aliasHash).toBe(expected.aliasHash);
  });

  it("resolves the Reference Record id by type key for accepted set-equivalent aliases", () => {
    const plan = planPromotionAliases({ candidates: [referenceCandidate()], resolution });

    const actions = proposeActions(plan);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.accept).toBe(true);
    expect(actions[0]?.targetResolved).toBe(true);
    expect(actions[0]?.candidate.target.targetId).toBe("ref_expansion_1");
  });

  it("proposes a key-only reference-record candidate when the record id is not resolved yet", () => {
    const plan = planPromotionAliases({
      candidates: [referenceCandidate({ target: { kind: "reference-record", targetKey: "series" } })],
      resolution: { catalogItemId: "cat_x", referenceRecordIdsByTypeKey: {} },
    });

    const actions = proposeActions(plan);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.targetResolved).toBe(false);
    // Not resolved -> never accepted into a publishable item-level fact.
    expect(actions[0]?.accept).toBe(false);
    expect(actions[0]?.candidate.target.targetId).toBeNull();
  });

  it("never accepts pending, rejected, or generated candidates", () => {
    const plan = planPromotionAliases({
      candidates: [
        itemCandidate({ reviewStatus: "pending" }),
        itemCandidate({
          aliasText: "Glurak",
          aliasLanguageCode: "de",
          reviewStatus: "rejected",
        }),
        itemCandidate({
          aliasText: "Lizardon",
          aliasLanguageCode: "ja",
          aliasType: "generated-translation",
          confidence: "generated",
          reviewStatus: "pending",
          provenance: { ...itemCandidate().provenance, sourceCategory: "machine-translation" },
        }),
      ],
      resolution,
    });

    expect(proposeActions(plan).every((action) => action.accept === false)).toBe(true);
  });

  it("resolves conflicting official equivalents by #1912 source precedence", () => {
    const curated = itemCandidate({
      reviewStatus: "accepted",
      provenance: { ...itemCandidate().provenance, sourceCategory: "curated-operator-mapping", observationId: "obs_1" },
    });
    const sameIdEndpoint = itemCandidate({
      reviewStatus: "accepted",
      provenance: {
        ...itemCandidate().provenance,
        sourceCategory: "provider-same-id-localized-endpoint",
        observationId: "obs_1",
      },
    });

    const plan = planPromotionAliases({ candidates: [sameIdEndpoint, curated], resolution });

    const accepted = proposeActions(plan).filter((action) => action.accept);
    expect(accepted).toHaveLength(1);
    // curated-operator-mapping (precedence 2) outranks same-id endpoint (precedence 3).
    expect(accepted[0]?.candidate.provenance.sourceCategory).toBe("curated-operator-mapping");
    const outranked = proposeActions(plan).find((action) => action.reason === "conflict-outranked");
    expect(outranked?.candidate.provenance.sourceCategory).toBe("provider-same-id-localized-endpoint");
    expect(outranked?.accept).toBe(false);
  });

  it("retracts a published alias when its candidate is now rejected", () => {
    const rejected = itemCandidate({ reviewStatus: "rejected" });
    const built = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "card-name" },
      aliasText: rejected.aliasText,
      aliasLanguageCode: rejected.aliasLanguageCode,
      sourceLanguageCode: rejected.sourceLanguageCode,
      aliasType: rejected.aliasType,
      confidence: rejected.confidence,
      reviewStatus: "accepted",
      provenance: rejected.provenance,
      evidence: rejected.evidence,
    });

    const plan = planPromotionAliases({
      candidates: [rejected],
      resolution,
      publishedCatalogItemAliases: [
        { aliasHash: built.aliasHash, reviewStatus: "accepted", observationId: "obs_1", providerKey: "tcgdex" },
      ],
    });

    const retractions = retractActions(plan);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]?.reason).toBe("rejected-candidate");
    expect(retractions[0]?.aliasHash).toBe(built.aliasHash);
  });

  it("retracts a published alias when its candidate is now revoked", () => {
    const revoked = itemCandidate({ reviewStatus: "revoked" });
    const built = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "card-name" },
      aliasText: revoked.aliasText,
      aliasLanguageCode: revoked.aliasLanguageCode,
      sourceLanguageCode: revoked.sourceLanguageCode,
      aliasType: revoked.aliasType,
      confidence: revoked.confidence,
      reviewStatus: "accepted",
      provenance: revoked.provenance,
      evidence: revoked.evidence,
    });

    const plan = planPromotionAliases({
      candidates: [revoked],
      resolution,
      publishedCatalogItemAliases: [
        { aliasHash: built.aliasHash, reviewStatus: "auto-accepted", observationId: "obs_1", providerKey: "tcgdex" },
      ],
    });

    // Revoked candidates are retracted, never re-proposed.
    expect(proposeActions(plan)).toHaveLength(0);
    const retractions = retractActions(plan);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]?.reason).toBe("revoked-candidate");
    expect(retractions[0]?.aliasHash).toBe(built.aliasHash);
  });

  it("does not propose rejected or revoked candidates (retraction only)", () => {
    const plan = planPromotionAliases({
      candidates: [
        itemCandidate({ aliasText: "Glurak", aliasLanguageCode: "de", reviewStatus: "rejected" }),
        itemCandidate({ aliasText: "Dracaufeu", aliasLanguageCode: "fr", reviewStatus: "revoked" }),
      ],
      resolution,
    });

    expect(proposeActions(plan)).toHaveLength(0);
    // No published aliases to match, so nothing to retract either.
    expect(retractActions(plan)).toHaveLength(0);
  });

  it("does not retract published aliases that the current accepted candidate still supports (idempotent reapply)", () => {
    const accepted = itemCandidate({ reviewStatus: "accepted" });
    const built = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "card-name" },
      aliasText: accepted.aliasText,
      aliasLanguageCode: accepted.aliasLanguageCode,
      sourceLanguageCode: accepted.sourceLanguageCode,
      aliasType: accepted.aliasType,
      confidence: accepted.confidence,
      reviewStatus: "accepted",
      provenance: accepted.provenance,
      evidence: accepted.evidence,
    });

    const plan = planPromotionAliases({
      candidates: [accepted],
      resolution,
      publishedCatalogItemAliases: [
        { aliasHash: built.aliasHash, reviewStatus: "accepted", observationId: "obs_1", providerKey: "tcgdex" },
      ],
    });

    expect(retractActions(plan)).toHaveLength(0);
    expect(proposeActions(plan)).toHaveLength(1);
    expect(proposeActions(plan)[0]?.accept).toBe(true);
  });

  it("never revokes another observation's published aliases on refresh", () => {
    const accepted = itemCandidate({ reviewStatus: "accepted" });
    const otherObservationAlias = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "card-name" },
      aliasText: "Otra",
      aliasLanguageCode: "es",
      sourceLanguageCode: "en",
      aliasType: "official-equivalent",
      confidence: "high",
      reviewStatus: "accepted",
      provenance: { ...accepted.provenance, observationId: "obs_other" },
      evidence: {},
    });

    const plan = planPromotionAliases({
      candidates: [accepted],
      resolution,
      publishedCatalogItemAliases: [
        {
          aliasHash: otherObservationAlias.aliasHash,
          reviewStatus: "accepted",
          observationId: "obs_other",
          providerKey: "tcgdex",
        },
      ],
    });

    expect(retractActions(plan)).toHaveLength(0);
  });
});

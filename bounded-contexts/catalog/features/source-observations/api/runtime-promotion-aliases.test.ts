import { describe, expect, it } from "vitest";
import { createSourceObservationRuntime } from "./runtime";
import { context, createChangedObservationRefreshHarness } from "./seeding/runtime-test-harness";
import { buildCatalogAliasCandidate } from "../../alias-equivalence/domain/alias";
import { catalogAliasStreamId, type CatalogAliasCommand } from "../../alias-equivalence/domain/domain";
import type { PromotionAliasCandidate, PromotionPublishedAlias } from "./promotion/provider-promotion-alias-planner";
import type { PromotionAliasServices } from "./promotion/provider-promotion-alias-writer";

// ---------------------------------------------------------------------------
// Promotion alias wiring (#1909): exercises the full runtime path that turns an
// observation's reviewed alias candidates into Catalog Item / Reference Record
// alias facts and retractions. Uses an in-memory promotion-alias services double
// so the test asserts the commands the runtime drives without a database.
// ---------------------------------------------------------------------------

function createAliasPromotionDouble(input: {
  candidates?: readonly PromotionAliasCandidate[];
  publishedCatalogItemAliases?: readonly PromotionPublishedAlias[];
  publishedReferenceRecordAliases?: Readonly<Record<string, readonly PromotionPublishedAlias[]>>;
}): { services: PromotionAliasServices; commands: CatalogAliasCommand[] } {
  const commands: CatalogAliasCommand[] = [];
  return {
    commands,
    services: {
      listCandidatesForObservation: async () => input.candidates ?? [],
      listPublishedCatalogItemAliases: async () => input.publishedCatalogItemAliases ?? [],
      listPublishedReferenceRecordAliases: async (recordId) => input.publishedReferenceRecordAliases?.[recordId] ?? [],
      catalogAliasCommandHandler: async ({ command }) => {
        commands.push(command);
        return { version: commands.length, state: {} as never, newEvents: [], storedEvents: [] };
      },
    },
  };
}

function itemAliasCandidate(overrides: Partial<PromotionAliasCandidate> = {}): PromotionAliasCandidate {
  return {
    target: { kind: "catalog-item", targetKey: "card-name" },
    aliasText: "Furēto",
    aliasLanguageCode: "ja",
    sourceLanguageCode: "en",
    aliasType: "provider-localized-name",
    confidence: "high",
    reviewStatus: "accepted",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_changed",
      sourceCategory: "provider-localized-name",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fingerprint:2026.06.03",
    },
    evidence: { sharedId: "me02.5-136" },
    ...overrides,
  };
}

function referenceAliasCandidate(overrides: Partial<PromotionAliasCandidate> = {}): PromotionAliasCandidate {
  return {
    target: { kind: "reference-record", targetKey: "expansion" },
    aliasText: "メガ進化",
    aliasLanguageCode: "ja",
    sourceLanguageCode: "en",
    aliasType: "set-equivalent",
    confidence: "exact",
    reviewStatus: "auto-accepted",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_changed",
      sourceCategory: "provider-same-id-localized-endpoint",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fingerprint:2026.06.03",
    },
    evidence: {},
    ...overrides,
  };
}

describe("source observation runtime: promotion writes accepted aliases (#1909)", () => {
  it("proposes and accepts an item alias with the resolved Catalog Item id", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "changed" });
    const aliasDouble = createAliasPromotionDouble({ candidates: [itemAliasCandidate()] });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.promoteObservation({ observationId: "obs_changed", context });

    const propose = aliasDouble.commands.find((command) => command.type === "ProposeCatalogAlias");
    expect(propose).toBeDefined();
    if (propose?.type === "ProposeCatalogAlias") {
      expect(propose.candidate.target.targetId).toBe("cat_existing");
      expect(propose.candidate.target.kind).toBe("catalog-item");
    }
    expect(aliasDouble.commands.some((command) => command.type === "AcceptCatalogAlias")).toBe(true);
  });

  it("proposes an auto-accepted reference-record alias without a redundant accept", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "changed" });
    const aliasDouble = createAliasPromotionDouble({ candidates: [referenceAliasCandidate()] });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.promoteObservation({ observationId: "obs_changed", context });

    const propose = aliasDouble.commands.find((command) => command.type === "ProposeCatalogAlias");
    expect(propose?.type).toBe("ProposeCatalogAlias");
    if (propose?.type === "ProposeCatalogAlias") {
      expect(propose.candidate.target.kind).toBe("reference-record");
      // The harness resolves provider expansion records to `ref_<normalized-key>`.
      expect(propose.candidate.target.targetId).toBe("ref_me02-5");
    }
    // Auto-accepted lands publishable on propose; no explicit accept needed.
    expect(aliasDouble.commands.some((command) => command.type === "AcceptCatalogAlias")).toBe(false);
  });

  it("does not accept rejected candidates and retracts a previously published alias", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "changed" });
    const rejected = itemAliasCandidate({ reviewStatus: "rejected" });
    const publishedHash = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_existing", targetKey: "card-name" },
      aliasText: rejected.aliasText,
      aliasLanguageCode: rejected.aliasLanguageCode,
      sourceLanguageCode: rejected.sourceLanguageCode,
      aliasType: rejected.aliasType,
      confidence: rejected.confidence,
      reviewStatus: "accepted",
      provenance: rejected.provenance,
      evidence: rejected.evidence,
    }).aliasHash;
    const aliasDouble = createAliasPromotionDouble({
      candidates: [rejected],
      publishedCatalogItemAliases: [
        { aliasHash: publishedHash, reviewStatus: "accepted", observationId: "obs_changed", providerKey: "tcgdex" },
      ],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.promoteObservation({ observationId: "obs_changed", context });

    // A rejected candidate never publishes and is never re-proposed; it only
    // retracts the previously published alias.
    expect(aliasDouble.commands.some((command) => command.type === "AcceptCatalogAlias")).toBe(false);
    expect(aliasDouble.commands.some((command) => command.type === "ProposeCatalogAlias")).toBe(false);
    const revoke = aliasDouble.commands.find((command) => command.type === "RevokeCatalogAlias");
    expect(revoke).toBeDefined();
    // The revoke targets the previously published alias stream.
    const revokeStream = catalogAliasStreamId(publishedHash);
    expect(revokeStream).toContain(publishedHash);
  });

  it("revokes a previously published alias whose candidate is now revoked while accepting a fresh one", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "changed" });
    const refreshed = itemAliasCandidate({ aliasText: "Furēto", reviewStatus: "accepted" });
    const revoked = itemAliasCandidate({ aliasText: "Old Localized Name", reviewStatus: "revoked" });
    const staleHash = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_existing", targetKey: "card-name" },
      aliasText: "Old Localized Name",
      aliasLanguageCode: revoked.aliasLanguageCode,
      sourceLanguageCode: revoked.sourceLanguageCode,
      aliasType: revoked.aliasType,
      confidence: revoked.confidence,
      reviewStatus: "accepted",
      provenance: revoked.provenance,
      evidence: revoked.evidence,
    }).aliasHash;
    const aliasDouble = createAliasPromotionDouble({
      candidates: [refreshed, revoked],
      publishedCatalogItemAliases: [
        { aliasHash: staleHash, reviewStatus: "accepted", observationId: "obs_changed", providerKey: "tcgdex" },
      ],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.promoteObservation({ observationId: "obs_changed", context });

    expect(aliasDouble.commands.filter((command) => command.type === "RevokeCatalogAlias")).toHaveLength(1);
    expect(aliasDouble.commands.some((command) => command.type === "AcceptCatalogAlias")).toBe(true);
  });

  it("is a no-op for observations without alias candidates", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "changed" });
    const aliasDouble = createAliasPromotionDouble({ candidates: [] });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.promoteObservation({ observationId: "obs_changed", context });

    expect(aliasDouble.commands).toHaveLength(0);
  });

  it("writes accepted aliases on reapply through the linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const aliasDouble = createAliasPromotionDouble({ candidates: [itemAliasCandidate()] });
    const services = createSourceObservationRuntime(
      harness.deps,
      harness.items,
      harness.referenceData,
      undefined,
      undefined,
      undefined,
      aliasDouble.services,
    );

    await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(aliasDouble.commands.some((command) => command.type === "ProposeCatalogAlias")).toBe(true);
    expect(aliasDouble.commands.some((command) => command.type === "AcceptCatalogAlias")).toBe(true);
  });
});

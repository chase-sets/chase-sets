import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { SourceObservationNormalized } from "../domain/domain";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
  type CatalogIntegrationRolloutControlPolicy,
} from "./governance/catalog-integration-rollout-controls";
import { catalogProviderProfileVersionIngestionUnitKey } from "./provider-integration-profiles";
import { createSourceObservationRuntime } from "./runtime";
import { snapshotCatalogProfileVersion } from "./source-observation-promotion-execution";
import { staticCatalogProviderIntegrationProfileVersions } from "./source-observation-runtime-contracts";
import {
  context,
  createBulkReviewJobHarness,
  createChangedObservationRefreshHarness,
  currentTcgdexProfileVersion,
  onePieceCardPrintObservation,
  onePieceSealedProductObservation,
  onePieceSetReferenceObservation,
  withoutRolloutUnitKey,
} from "./seeding/runtime-test-harness";

// SYNTHETIC replay pack asset (a 16x16 checkerboard PNG): replay reconciliation always carries one.
async function syntheticReplayAsset() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 3, 255);
  for (let index = 0; index < size * size; index += 1) {
    if ((Math.floor(index / size) + index) % 2 === 0) {
      pixels.fill(0, index * 3, index * 3 + 3);
    }
  }
  const body = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
  return {
    body: new Uint8Array(body),
    contentType: "image/png",
    sourceUrl: null,
    sourceHash: "sha256:synthetic-replay-asset",
  };
}

const PROMOTION_UNIT_STOP_MESSAGE =
  "Catalog integration promotion is disabled for the configured ingestion-unit scope.";
const REAPPLY_UNIT_STOP_MESSAGE = "Catalog integration reapply is disabled for the configured ingestion-unit scope.";

/**
 * Resolves an observation's execution profile through the same reader the
 * runtime uses, so every unit key below is derived, never typed by hand.
 */
async function executionProfileVersion(providerKey: string, normalized: SourceObservationNormalized) {
  const versions = await staticCatalogProviderIntegrationProfileVersions.listProfileVersions(providerKey);
  const matching = versions.filter(
    (version) => version.active && version.profile.normalizedObservationMapping.kind === normalized.kind,
  );
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

async function executionUnitKey(providerKey: string, normalized: SourceObservationNormalized) {
  return catalogProviderProfileVersionIngestionUnitKey(await executionProfileVersion(providerKey, normalized));
}

function onePieceCardPrintHarness(input: {
  status: "observed" | "promoted";
  siblings?: boolean;
  withAssetStorage?: boolean;
}) {
  return createChangedObservationRefreshHarness({
    providerKey: "scrydex",
    externalKey: "card:op01-001",
    sourceUrl: "https://api.scrydex.example/onepiece/v1/cards/op01-001",
    sourceProfileKey: "one-piece-card-print-source-observation",
    sourceProfileVersion: "2026.06.22",
    sourceMappingFingerprint: "fingerprint:scrydex:one-piece-card:2026.06.22",
    status: input.status,
    promotedCatalogItemId: input.status === "promoted" ? "cat_existing" : null,
    normalized: onePieceCardPrintObservation(),
    // SYNTHETIC asset storage for replay reconciliation, which always carries a pack asset.
    assetStorage: input.withAssetStorage
      ? {
          async putObject(object) {
            return { key: object.key, publicUrl: `https://assets.chasesets.test/${object.key}` };
          },
        }
      : undefined,
    siblingObservations: input.siblings
      ? [
          {
            observationId: "obs_sealed",
            providerKey: "scrydex",
            externalKey: "sealed:op01-booster-box",
            sourceProfileKey: "one-piece-sealed-product-source-observation",
            sourceProfileVersion: "2026.06.22",
            normalized: onePieceSealedProductObservation(),
          },
          {
            observationId: "obs_set",
            providerKey: "scrydex",
            externalKey: "set:op01",
            sourceProfileKey: "one-piece-set-reference-data",
            sourceProfileVersion: "2026.06.22",
            normalized: onePieceSetReferenceObservation(),
          },
        ]
      : [],
  });
}

function onePieceSetReferenceHarness(input: { status: "observed" | "promoted" }) {
  return createChangedObservationRefreshHarness({
    providerKey: "scrydex",
    externalKey: "set:op01",
    sourceUrl: "https://api.scrydex.example/onepiece/v1/expansions/op01",
    sourceProfileKey: "one-piece-set-reference-data",
    sourceProfileVersion: "2026.06.22",
    sourceMappingFingerprint: "fingerprint:scrydex:one-piece-set:2026.06.22",
    status: input.status,
    promotedCatalogItemId: null,
    promotedReferenceRecordId: input.status === "promoted" ? "ref_op01" : null,
    normalized: onePieceSetReferenceObservation(),
  });
}

function runtimeFor(
  harness: ReturnType<typeof createChangedObservationRefreshHarness>,
  policy: CatalogIntegrationRolloutControlPolicy,
) {
  return createSourceObservationRuntime(
    harness.deps,
    harness.items,
    harness.referenceData,
    staticCatalogProviderIntegrationProfileVersions,
    policy,
  );
}

function eventTypes(harness: ReturnType<typeof createChangedObservationRefreshHarness>) {
  return harness.appendedSourceEvents.map((event) => event.eventType);
}

function expectUnitDenial(error: unknown, controlId: string, unitKey: string) {
  expect(error).toBeInstanceOf(CatalogIntegrationRolloutControlError);
  expect((error as CatalogIntegrationRolloutControlError).decision.controls).toEqual([
    expect.objectContaining({ controlId, status: "blocked", unitKeys: expect.arrayContaining([unitKey]) }),
  ]);
}

describe("source observation runtime: resolved-unit promotion and reapply rollout enforcement", () => {
  it("denies single Catalog Item promotion for a stopped unit before any write and promotes once controls reopen", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] });
    const harness = onePieceCardPrintHarness({ status: "observed" });

    const error = await runtimeFor(harness, policy)
      .promoteObservation({ observationId: "obs_changed", context })
      .catch((caught: unknown) => caught);

    expectUnitDenial(error, "promotion-disabled", cardUnitKey);
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);

    // Retry after the stop is lifted resolves the same current-active profile and promotes.
    const retried = await runtimeFor(harness, createCatalogIntegrationRolloutControlPolicy()).promoteObservation({
      observationId: "obs_changed",
      context,
    });
    expect(retried.catalogItemId).toMatch(/^cat_/);
    expect(eventTypes(harness)).toContain("catalog.source-observation.promoted");
  });

  it("removing the execution unit key lets the stopped unit promote (negative control)", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const harness = onePieceCardPrintHarness({ status: "observed" });

    await runtimeFor(
      harness,
      withoutRolloutUnitKey(createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] })),
    ).promoteObservation({ observationId: "obs_changed", context });

    expect(harness.itemCommands.length).toBeGreaterThan(0);
    expect(eventTypes(harness)).toContain("catalog.source-observation.promoted");
  });

  it("denies single Reference Record promotion for its stopped unit while a sibling unit stop on the same provider does not apply", async () => {
    const setUnitKey = await executionUnitKey("scrydex", onePieceSetReferenceObservation());
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const stopped = onePieceSetReferenceHarness({ status: "observed" });

    const error = await runtimeFor(
      stopped,
      createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [setUnitKey] }),
    )
      .promoteObservation({ observationId: "obs_changed", context })
      .catch((caught: unknown) => caught);
    expectUnitDenial(error, "promotion-disabled", setUnitKey);
    expect(stopped.referenceRecordCreateCommands).toEqual([]);
    expect(stopped.appendedSourceEvents).toEqual([]);

    const sibling = onePieceSetReferenceHarness({ status: "observed" });
    await expect(
      runtimeFor(
        sibling,
        createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] }),
      ).promoteObservation({ observationId: "obs_changed", context }),
    ).resolves.toMatchObject({ referenceRecordId: "ref_op01" });
    expect(eventTypes(sibling)).toContain("catalog.source-observation.reference-promoted");

    const unscoped = onePieceSetReferenceHarness({ status: "observed" });
    await expect(
      runtimeFor(
        unscoped,
        withoutRolloutUnitKey(createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [setUnitKey] })),
      ).promoteObservation({ observationId: "obs_changed", context }),
    ).resolves.toMatchObject({ referenceRecordId: "ref_op01" });
  });

  it("promotes allowed members of a mixed bulk batch and never mutates denied Catalog Item or Reference Record members", async () => {
    const sealedUnitKey = await executionUnitKey("scrydex", onePieceSealedProductObservation());
    const setUnitKey = await executionUnitKey("scrydex", onePieceSetReferenceObservation());
    const harness = onePieceCardPrintHarness({ status: "observed", siblings: true });

    const result = await runtimeFor(
      harness,
      createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [sealedUnitKey, setUnitKey] }),
    ).promoteObservations({ observationIds: ["obs_changed", "obs_sealed", "obs_set"], context });

    expect(result).toMatchObject({ requested: 3, promoted: 1, failed: 2 });
    expect(result.outcomes).toEqual([
      expect.objectContaining({ observationId: "obs_changed", status: "promoted" }),
      { observationId: "obs_sealed", status: "failed", catalogItemId: null, reason: PROMOTION_UNIT_STOP_MESSAGE },
      { observationId: "obs_set", status: "failed", catalogItemId: null, reason: PROMOTION_UNIT_STOP_MESSAGE },
    ]);
    expect(eventTypes(harness).filter((type) => type === "catalog.source-observation.promoted")).toHaveLength(1);
    expect(eventTypes(harness)).not.toContain("catalog.source-observation.reference-promoted");

    const unscoped = onePieceCardPrintHarness({ status: "observed", siblings: true });
    const unscopedResult = await runtimeFor(
      unscoped,
      withoutRolloutUnitKey(
        createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [sealedUnitKey, setUnitKey] }),
      ),
    ).promoteObservations({ observationIds: ["obs_changed", "obs_sealed", "obs_set"], context });
    expect(unscopedResult.outcomes.map((outcome) => outcome.reason)).not.toContain(PROMOTION_UNIT_STOP_MESSAGE);
  });

  it("enforces the resolved unit for filter-scoped bulk promotion", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const harness = onePieceCardPrintHarness({ status: "observed" });

    const result = await runtimeFor(
      harness,
      createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] }),
    ).promoteObservationScope({ scope: { provider: "scrydex" }, context });

    expect(result.outcomes).toEqual([
      { observationId: "obs_changed", status: "failed", catalogItemId: null, reason: PROMOTION_UNIT_STOP_MESSAGE },
    ]);
    expect(harness.itemCommands).toEqual([]);
  });

  it("denies the bulk-review promote worker for a stopped resolved unit", async () => {
    const tcgdexUnitKey = catalogProviderProfileVersionIngestionUnitKey(currentTcgdexProfileVersion());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [tcgdexUnitKey] });
    const runWorker = async (rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy) => {
      const harness = createBulkReviewJobHarness(1, { action: "promote" });
      await createSourceObservationRuntime(
        harness.deps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
        staticCatalogProviderIntegrationProfileVersions,
        rolloutControlPolicy,
      ).processNextBulkReviewJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 });
      return harness;
    };

    const denied = await runWorker(policy);
    expect(denied.job.result?.outcomes).toEqual([
      expect.objectContaining({ observationId: "obs_1", status: "failed", reason: PROMOTION_UNIT_STOP_MESSAGE }),
    ]);
    expect(denied.appendedEvents).toEqual([]);

    // Negative control: without the unit key the worker gets past admission (and fails later on the stub services).
    const unscoped = await runWorker(withoutRolloutUnitKey(policy));
    expect(unscoped.job.result?.outcomes).toEqual([
      expect.objectContaining({ observationId: "obs_1", reason: expect.not.stringContaining("rollout") }),
    ]);
    expect(unscoped.job.result?.outcomes).not.toEqual([
      expect.objectContaining({ reason: PROMOTION_UNIT_STOP_MESSAGE }),
    ]);
  });

  it("denies Catalog Item reapply for the current-active, captured and original-source profile unit", async () => {
    const cardVersion = await executionProfileVersion("scrydex", onePieceCardPrintObservation());
    const cardUnitKey = catalogProviderProfileVersionIngestionUnitKey(cardVersion);
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledReapplyUnits: [cardUnitKey] });
    const selections = [
      { reapplyProfileMode: "current-active-profile" as const, profileSnapshot: null },
      {
        reapplyProfileMode: "current-active-profile" as const,
        profileSnapshot: snapshotCatalogProfileVersion(cardVersion),
      },
      { reapplyProfileMode: "original-source-profile" as const, profileSnapshot: null },
    ];

    for (const selection of selections) {
      const harness = onePieceCardPrintHarness({ status: "promoted" });
      const result = await runtimeFor(harness, policy).reapplyObservations({
        observationIds: ["obs_changed"],
        context,
        ...selection,
      });
      expect(result.outcomes).toEqual([
        { observationId: "obs_changed", status: "failed", catalogItemId: null, reason: REAPPLY_UNIT_STOP_MESSAGE },
      ]);
      expect(harness.itemCommands).toEqual([]);
      expect(harness.appendedSourceEvents).toEqual([]);

      const unscoped = onePieceCardPrintHarness({ status: "promoted" });
      await expect(
        runtimeFor(unscoped, withoutRolloutUnitKey(policy)).reapplyObservations({
          observationIds: ["obs_changed"],
          context,
          ...selection,
        }),
      ).resolves.toMatchObject({ reapplied: 1 });
    }
  });

  it("does not treat a promotion unit stop as a reapply stop", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const harness = onePieceCardPrintHarness({ status: "promoted" });

    await expect(
      runtimeFor(
        harness,
        createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] }),
      ).reapplyObservations({
        observationIds: ["obs_changed"],
        context,
        reapplyProfileMode: "current-active-profile",
      }),
    ).resolves.toMatchObject({ reapplied: 1 });
  });

  it("denies Reference Record reapply for its stopped unit without Reference Record plan writes", async () => {
    const setUnitKey = await executionUnitKey("scrydex", onePieceSetReferenceObservation());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledReapplyUnits: [setUnitKey] });
    const harness = onePieceSetReferenceHarness({ status: "promoted" });

    const result = await runtimeFor(harness, policy).reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "current-active-profile",
    });

    expect(result.outcomes).toEqual([
      { observationId: "obs_changed", status: "failed", catalogItemId: null, reason: REAPPLY_UNIT_STOP_MESSAGE },
    ]);
    expect(harness.appendedSourceEvents).toEqual([]);

    const unscoped = onePieceSetReferenceHarness({ status: "promoted" });
    await expect(
      runtimeFor(unscoped, withoutRolloutUnitKey(policy)).reapplyObservations({
        observationIds: ["obs_changed"],
        context,
        reapplyProfileMode: "current-active-profile",
      }),
    ).resolves.toMatchObject({ reapplied: 1 });
  });

  it("denies replay reconciliation of a promoted observation for its stopped promotion unit", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledPromotionUnits: [cardUnitKey] });

    const error = await runtimeFor(onePieceCardPrintHarness({ status: "promoted", withAssetStorage: true }), policy)
      .reconcilePromotedObservationForReplay({
        observationId: "obs_changed",
        context,
        productAssetSource: await syntheticReplayAsset(),
      })
      .catch((caught: unknown) => caught);
    expectUnitDenial(error, "promotion-disabled", cardUnitKey);

    await expect(
      runtimeFor(
        onePieceCardPrintHarness({ status: "promoted", withAssetStorage: true }),
        withoutRolloutUnitKey(policy),
      ).reconcilePromotedObservationForReplay({
        observationId: "obs_changed",
        context,
        productAssetSource: await syntheticReplayAsset(),
      }),
    ).resolves.toMatchObject({ catalogItemId: "cat_existing" });
  });

  it("enforces the existing One Piece signoff for promotion and reapply while its excluded set-reference unit stays ungated", async () => {
    const cardUnitKey = await executionUnitKey("scrydex", onePieceCardPrintObservation());
    const unsignedPolicy = createCatalogIntegrationRolloutControlPolicy({ onePieceProductionSignoffReference: null });
    const signedPolicy = createCatalogIntegrationRolloutControlPolicy({
      onePieceProductionSignoffReference: "#2285 UI-only staging UAT evidence",
    });

    const unsignedPromotion = onePieceCardPrintHarness({ status: "observed" });
    const promotionError = await runtimeFor(unsignedPromotion, unsignedPolicy)
      .promoteObservation({ observationId: "obs_changed", context })
      .catch((caught: unknown) => caught);
    expectUnitDenial(promotionError, "one-piece-production-signoff-required", cardUnitKey);
    expect(unsignedPromotion.itemCommands).toEqual([]);

    const unsignedReapply = onePieceCardPrintHarness({ status: "promoted" });
    await expect(
      runtimeFor(unsignedReapply, unsignedPolicy).reapplyObservations({
        observationIds: ["obs_changed"],
        context,
        reapplyProfileMode: "current-active-profile",
      }),
    ).resolves.toMatchObject({ reapplied: 0, failed: 1 });
    expect(unsignedReapply.itemCommands).toEqual([]);

    const signedPromotion = onePieceCardPrintHarness({ status: "observed" });
    await expect(
      runtimeFor(signedPromotion, signedPolicy).promoteObservation({ observationId: "obs_changed", context }),
    ).resolves.toMatchObject({ catalogItemId: expect.stringMatching(/^cat_/) });
    await expect(
      runtimeFor(onePieceCardPrintHarness({ status: "promoted" }), signedPolicy).reapplyObservations({
        observationIds: ["obs_changed"],
        context,
        reapplyProfileMode: "current-active-profile",
      }),
    ).resolves.toMatchObject({ reapplied: 1 });

    // The excluded One Piece set-reference unit keeps its existing, ungated membership.
    await expect(
      runtimeFor(onePieceSetReferenceHarness({ status: "observed" }), unsignedPolicy).promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toMatchObject({ referenceRecordId: "ref_op01" });

    // Negative control: provider-only admission never matches the unit-scoped signoff gate.
    await expect(
      runtimeFor(
        onePieceCardPrintHarness({ status: "observed" }),
        withoutRolloutUnitKey(unsignedPolicy),
      ).promoteObservation({ observationId: "obs_changed", context }),
    ).resolves.toMatchObject({ catalogItemId: expect.stringMatching(/^cat_/) });
  });
});

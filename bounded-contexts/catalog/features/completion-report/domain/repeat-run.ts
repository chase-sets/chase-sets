import { unitKey, type ProductionCatalogCompletionManifest } from "./manifest";

// Repeat-run reconciliation proves that re-executing the accepted manifest
// converges: it must create no duplicate Catalog truth, must not change the
// frozen plan, and must not discover unexpected new work. Any of those is a
// launch blocker.

export const repeatRunFindingCodes = [
  "plan-fingerprint-changed",
  "duplicate-catalog-truth",
  "unexpected-work",
] as const;
export type RepeatRunFindingCode = (typeof repeatRunFindingCodes)[number];

export type RepeatRunFinding = Readonly<{
  code: RepeatRunFindingCode;
  message: string;
}>;

export type RepeatRunReconciliation = Readonly<{
  convergent: boolean;
  acceptedBatchId: string;
  repeatBatchId: string;
  deltas: Readonly<{
    catalogItemPublishedDelta: number;
    catalogItemDraftDelta: number;
    promotionCreateDelta: number;
    promotionUpdateDelta: number;
    sourceObservationPromotedDelta: number;
    newlyIntroducedUnitCount: number;
  }>;
  findings: readonly RepeatRunFinding[];
}>;

// Compare a repeat execution manifest against the previously accepted manifest.
export function reconcileRepeatRun(
  accepted: ProductionCatalogCompletionManifest,
  repeat: ProductionCatalogCompletionManifest,
): RepeatRunReconciliation {
  const findings: RepeatRunFinding[] = [];

  if (accepted.batch.planFingerprint !== repeat.batch.planFingerprint) {
    findings.push({
      code: "plan-fingerprint-changed",
      message: "Repeat-run plan fingerprint differs from the accepted manifest; the frozen plan is no longer current.",
    });
  }

  const catalogItemPublishedDelta = repeat.catalogItems.published - accepted.catalogItems.published;
  const catalogItemDraftDelta = repeat.catalogItems.draft - accepted.catalogItems.draft;
  const promotionCreateDelta = repeat.promotions.create - accepted.promotions.create;
  const promotionUpdateDelta = repeat.promotions.update - accepted.promotions.update;
  const sourceObservationPromotedDelta = repeat.sourceObservations.promoted - accepted.sourceObservations.promoted;

  // Duplicate Catalog truth: a converged repeat must not mint new Catalog Items
  // or promote additional source observations into new Catalog truth.
  if (catalogItemPublishedDelta > 0 || promotionCreateDelta > 0 || sourceObservationPromotedDelta > 0) {
    findings.push({
      code: "duplicate-catalog-truth",
      message: `Repeat run introduced new Catalog truth (published +${catalogItemPublishedDelta}, promotion-create +${promotionCreateDelta}, promoted-observation +${sourceObservationPromotedDelta}).`,
    });
  }

  const acceptedUnits = new Set(
    accepted.expectedUnits.map((unit) => unitKey(unit.scopeRecordId, unit.providerKey, unit.unitKey)),
  );
  const newlyIntroducedUnits = repeat.expectedUnits.filter(
    (unit) => !acceptedUnits.has(unitKey(unit.scopeRecordId, unit.providerKey, unit.unitKey)),
  );

  // Unexpected work: new planned units, additional promotions/updates, or new
  // draft items beyond the accepted baseline mean the run was not a no-op.
  if (newlyIntroducedUnits.length > 0 || promotionUpdateDelta > 0 || catalogItemDraftDelta > 0) {
    findings.push({
      code: "unexpected-work",
      message: `Repeat run discovered unexpected work (${newlyIntroducedUnits.length} new planned unit(s), promotion-update +${promotionUpdateDelta}, draft +${catalogItemDraftDelta}).`,
    });
  }

  return {
    convergent: findings.length === 0,
    acceptedBatchId: accepted.batch.batchId,
    repeatBatchId: repeat.batch.batchId,
    deltas: {
      catalogItemPublishedDelta,
      catalogItemDraftDelta,
      promotionCreateDelta,
      promotionUpdateDelta,
      sourceObservationPromotedDelta,
      newlyIntroducedUnitCount: newlyIntroducedUnits.length,
    },
    findings,
  };
}

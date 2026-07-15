import { describe, expect, it, vi } from "vitest";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  createSourceObservationRuntime,
  type BulkReviewJobServices,
  type CatalogIntegrationEngineServices,
  type CatalogMergeCandidateServices,
  type ControlPlaneTelemetryServices,
  type IntegrationJobServices,
  type ProviderAdapterServices,
  type ProviderOptionQueryServices,
  type ProviderProfileAdminServices,
  type PromotionReapplyServices,
  type SourceObservationReadServices,
  type SourceObservationReviewServices,
} from "./runtime";

describe("Source Observation service facets", () => {
  it("exposes focused facets from the aggregate runtime", () => {
    const services = createSourceObservationRuntime(
      { checkpointStore: {}, db: {}, eventStore: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const providerAdapters: ProviderAdapterServices = services;
    const providerOptions: ProviderOptionQueryServices = services;
    const providerProfileAdmin: ProviderProfileAdminServices = services;
    const engine: CatalogIntegrationEngineServices = services;
    const review: SourceObservationReviewServices = services;
    const promotionReapply: PromotionReapplyServices = services;
    const bulkReviewJobs: BulkReviewJobServices = services;
    const integrationJobs: IntegrationJobServices = services;
    const reads: SourceObservationReadServices = services;
    const mergeCandidates: CatalogMergeCandidateServices = services;
    const telemetry: ControlPlaneTelemetryServices = services;

    expect(providerAdapters.providerAdapterRegistry.require("reference-cards").providerKey).toBe("reference-cards");
    expect(providerAdapters.providerAdapterRegistry.require("tcgdex").providerKey).toBe("tcgdex");
    expect(providerAdapters.providerAdapterRegistry.require("tcgplayer").providerKey).toBe("tcgplayer");
    expect(typeof providerOptions.listIntegrationOptions).toBe("function");
    expect(typeof providerProfileAdmin.getSelectedOptionAuthoringSchema).toBe("function");
    expect(typeof engine.getCatalogIntegrationControlPlaneReadiness).toBe("function");
    expect(typeof review.promoteObservation).toBe("function");
    expect(typeof promotionReapply.previewReapplyObservationScope).toBe("function");
    expect(typeof bulkReviewJobs.processNextBulkReviewJob).toBe("function");
    expect(typeof integrationJobs.processNextIntegrationJob).toBe("function");
    expect(typeof reads.listSourceObservations).toBe("function");
    expect(typeof reads.listCatalogMergeCandidates).toBe("function");
    expect(typeof mergeCandidates.generateCatalogMergeCandidates).toBe("function");
    expect(typeof mergeCandidates.previewCatalogMergeCandidatePromotionPlan).toBe("function");
    expect(typeof telemetry.recordControlPlaneTelemetry).toBe("function");
  });

  it("normalizes control-plane telemetry before recording through the host port", () => {
    const recordControlPlaneEvent = vi.fn();
    const services = createSourceObservationRuntime(
      {
        checkpointStore: {},
        db: {},
        eventStore: {},
        sourceObservationTelemetry: { recordControlPlaneEvent },
      } as unknown as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    services.recordControlPlaneTelemetry({
      eventName: "catalog_control_plane.blocker_hit",
      providerKey: "provider@example.com",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      scopeId: "en:3:base:base1",
      profileRef: "pokemon-tcg:2026.06.04",
      jobRefState: "job_123" as never,
      observationStatus: "changed",
      observationCount: 42,
      promotionResult: "operator note" as never,
      promotionCount: 2,
      blockerCategory: "provider-transport",
      detourTarget: "adapter-readiness",
      detourOutcome: "opened",
      roleBucket: "operator",
      readModelFreshness: "fresh",
    });

    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      eventName: "catalog_control_plane.blocker_hit",
      providerKey: "none",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      scopeId: "en:3:base:base1",
      profileRef: "pokemon-tcg:2026.06.04",
      jobRefState: "none",
      observationStatus: "changed",
      observationCountBucket: "11-100",
      promotionResult: "none",
      promotionCountBucket: "2-10",
      blockerCategory: "provider-transport",
      detourTarget: "adapter-readiness",
      detourOutcome: "opened",
      roleBucket: "operator",
      readModelFreshness: "fresh",
    });
  });

  it("reports reference and TCGdex dry-run proof readiness by ingestion unit", async () => {
    const services = createSourceObservationRuntime(
      { checkpointStore: {}, db: {}, eventStore: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const readiness = await services.getCatalogIntegrationControlPlaneReadiness();
    const referenceUnit = readiness.units.find(
      (unit) => unit.unitKey === "reference-cards:pokemon:single-card:source-observation-proof",
    );
    const tcgdexUnit = readiness.units.find(
      (unit) => unit.unitKey === "tcgdex:pokemon:single-card:source-observation-import",
    );

    expect(referenceUnit).toMatchObject({
      semanticReadiness: "ready",
      dryRunStatus: "completed",
      dryRunEvidence: [expect.objectContaining({ externalKey: "pokemon:abra-43" })],
    });
    expect(tcgdexUnit).toMatchObject({
      providerKey: "tcgdex",
      semanticReadiness: "ready",
      transportReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      dryRunEvidence: [
        {
          externalKey: "swsh3-136",
          sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
          sourceHash: null,
          normalizedFacts: expect.objectContaining({
            name: "Furret",
            cardNumber: "136",
            expansionName: "Darkness Ablaze",
          }),
        },
      ],
    });
  });
});

import { describe, expect, it } from "vitest";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  createSourceObservationRuntime,
  type BulkReviewJobServices,
  type CatalogIntegrationEngineServices,
  type IntegrationJobServices,
  type ProviderAdapterServices,
  type ProviderImportOrchestrationServices,
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
    const providerImports: ProviderImportOrchestrationServices = services;
    const providerOptions: ProviderOptionQueryServices = services;
    const providerProfileAdmin: ProviderProfileAdminServices = services;
    const engine: CatalogIntegrationEngineServices = services;
    const review: SourceObservationReviewServices = services;
    const promotionReapply: PromotionReapplyServices = services;
    const bulkReviewJobs: BulkReviewJobServices = services;
    const integrationJobs: IntegrationJobServices = services;
    const reads: SourceObservationReadServices = services;

    expect(providerAdapters.providerAdapterRegistry.require("reference-cards").providerKey).toBe("reference-cards");
    expect(providerAdapters.providerAdapterRegistry.require("tcgdex").providerKey).toBe("tcgdex");
    expect(typeof providerImports.importTcgplayerScope).toBe("function");
    expect(typeof providerOptions.listIntegrationOptions).toBe("function");
    expect(typeof providerProfileAdmin.getSelectedOptionAuthoringSchema).toBe("function");
    expect(typeof engine.getCatalogIntegrationControlPlaneReadiness).toBe("function");
    expect(typeof review.promoteObservation).toBe("function");
    expect(typeof promotionReapply.previewReapplyObservationScope).toBe("function");
    expect(typeof bulkReviewJobs.processNextBulkReviewJob).toBe("function");
    expect(typeof integrationJobs.processNextIntegrationJob).toBe("function");
    expect(typeof reads.listSourceObservations).toBe("function");
  });
});

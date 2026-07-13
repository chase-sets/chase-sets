import { describe, expect, it } from "vitest";
import type { CatalogPrimaryWorkbenchCatalogSyncReadModel } from "../api/primary-workbench-admin-contracts";
import { catalogSyncEstimateForSelection } from "./primary-workbench-catalog-sync";

describe("Catalog sync workbench read model", () => {
  it("recalculates the aggregate estimate and metered-provider callout after opt-out", () => {
    const preview = {
      estimate: {
        totalEstimatedRequestCount: 3,
        estimateState: "estimated" as const,
        estimateReason: null,
        creditConsumingProviders: [
          { providerKey: "scrydex", displayName: "Scrydex", unitKeys: ["scrydex:one-piece:card:import"] },
        ],
      },
      units: [
        unit({
          providerKey: "tcgdex",
          unitKey: "tcgdex:one-piece:card:import",
          estimatedRequestCount: 1,
        }),
        unit({
          providerKey: "scrydex",
          unitKey: "scrydex:one-piece:card:import",
          estimatedRequestCount: 2,
        }),
      ],
    } satisfies Pick<CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"], "estimate" | "units">;

    expect(catalogSyncEstimateForSelection(preview, new Set(["tcgdex:one-piece:card:import"]))).toEqual({
      totalEstimatedRequestCount: 1,
      estimateState: "estimated",
      estimateReason: null,
      creditConsumingProviders: [],
    });
  });
});

function unit(input: {
  providerKey: string;
  unitKey: string;
  estimatedRequestCount: number | null;
}): CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"]["units"][number] {
  return {
    providerKey: input.providerKey,
    unitKey: input.unitKey,
    displayName: input.providerKey,
    profileVersion: "2026.07.01",
    productDomain: "one-piece",
    productForm: "card",
    role: "supplementary",
    requirement: "optional",
    selected: true,
    eligibility: "eligible",
    childExecutionScope: {},
    estimate: {
      estimateState: input.estimatedRequestCount === null ? "estimate-unavailable" : "estimated",
      estimatedRequestCount: input.estimatedRequestCount,
      estimateReason: input.estimatedRequestCount === null ? "Provider did not estimate." : null,
    },
    blockers: [],
  };
}

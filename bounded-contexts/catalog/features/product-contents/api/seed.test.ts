import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedProductContentConfiguration, seedProductContentScenario } from "./seed";

function createSeedServices() {
  const productContents = {
    upsertContentType: vi.fn(async () => undefined),
    upsertInclusionPolicy: vi.fn(async () => undefined),
    replaceProductContents: vi.fn(async () => undefined),
  };

  return {
    services: {
      productContents,
    } as unknown as CatalogServices,
    productContents,
  };
}

describe("product contents seed", () => {
  it("reconciles configured content types and inclusion policies without scenario data", async () => {
    const { services, productContents } = createSeedServices();

    await seedProductContentConfiguration(services);

    expect(productContents.upsertContentType).toHaveBeenCalledTimes(4);
    expect(productContents.upsertContentType).toHaveBeenCalledWith(
      expect.objectContaining({
        contentTypeId: catalogSeedIds.productContentTypes.card,
        key: "card",
        discoverySearchWeight: 0.7,
      }),
    );
    expect(productContents.upsertInclusionPolicy).toHaveBeenCalledTimes(4);
    expect(productContents.replaceProductContents).not.toHaveBeenCalled();
  });

  it("adds a representative scenario relationship for end-to-end rollout proof", async () => {
    const { services, productContents } = createSeedServices();

    await seedProductContentScenario(services);

    expect(productContents.replaceProductContents).toHaveBeenCalledTimes(1);
    expect(productContents.replaceProductContents).toHaveBeenCalledWith(
      expect.objectContaining({
        containerCatalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
        lines: [
          expect.objectContaining({
            containedCatalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
            contentTypeId: catalogSeedIds.productContentTypes.card,
            inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.randomized,
            provenance: expect.objectContaining({ source: "scenario-seed" }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });
});

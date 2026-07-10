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
  const db = {
    query: vi.fn(async () => ({
      rows: [
        { catalog_item_id: catalogSeedIds.items.prismaticEvolutionsBoosterPack },
        { catalog_item_id: catalogSeedIds.items.pikachuPrismaticEvolutions },
      ],
    })),
  };

  return {
    services: {
      productContents,
      db,
    } as unknown as CatalogServices,
    productContents,
    db,
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
    const { services, productContents, db } = createSeedServices();

    await expect(seedProductContentScenario(services)).resolves.toBe(true);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM catalog_items"), [
      [catalogSeedIds.items.prismaticEvolutionsBoosterPack, catalogSeedIds.items.pikachuPrismaticEvolutions],
    ]);
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

  it("records representative refresh provenance for the staging-owned scenario", async () => {
    const { services, productContents } = createSeedServices();

    await seedProductContentScenario(services, { provenanceSource: "representative-commerce-state" });

    expect(productContents.replaceProductContents).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          expect.objectContaining({
            provenance: expect.objectContaining({ source: "representative-commerce-state" }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("waits for Catalog Item projections before writing the representative scenario relationship", async () => {
    const { services, productContents, db } = createSeedServices();
    db.query.mockResolvedValueOnce({
      rows: [{ catalog_item_id: catalogSeedIds.items.prismaticEvolutionsBoosterPack }],
    });

    await expect(seedProductContentScenario(services)).resolves.toBe(false);

    expect(productContents.upsertContentType).toHaveBeenCalledTimes(4);
    expect(productContents.upsertInclusionPolicy).toHaveBeenCalledTimes(4);
    expect(productContents.replaceProductContents).not.toHaveBeenCalled();
  });
});

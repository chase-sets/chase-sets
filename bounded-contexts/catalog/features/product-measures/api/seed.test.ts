import { describe, expect, it, vi } from "vitest";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedProductMeasures } from "./seed";

function createSeedServices() {
  const productMeasures = {
    upsertProfile: vi.fn(async () => undefined),
    resolveAllCatalogItemMeasures: vi.fn(async () => undefined),
  };

  return {
    services: {
      productMeasures,
    } as unknown as CatalogServices,
    productMeasures,
  };
}

describe("product measure seed", () => {
  it("can seed reusable profiles without resolving every existing Catalog Item", async () => {
    const { services, productMeasures } = createSeedServices();

    await seedProductMeasures(services, {
      resolveExistingCatalogItems: false,
    });

    expect(productMeasures.upsertProfile).toHaveBeenCalledTimes(11);
    expect(productMeasures.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "pokemon-graded-slab",
        matchSelectedOptions: [
          expect.objectContaining({
            dimensionId: expect.any(String),
            optionId: expect.any(String),
          }),
        ],
        precedence: 25,
      }),
    );
    expect(productMeasures.resolveAllCatalogItemMeasures).not.toHaveBeenCalled();
  });

  it("keeps full existing-item resolution available for scenario bootstrap", async () => {
    const { services, productMeasures } = createSeedServices();

    await seedProductMeasures(services, {
      resolveExistingCatalogItems: true,
    });

    expect(productMeasures.upsertProfile).toHaveBeenCalledTimes(11);
    expect(productMeasures.resolveAllCatalogItemMeasures).toHaveBeenCalledTimes(1);
  });
});

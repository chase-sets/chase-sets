import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedProductMeasures } from "./seed";

function createSeedServices() {
  const productMeasures = {
    upsertProfile: vi.fn<CatalogServices["productMeasures"]["upsertProfile"]>(),
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

    expect(productMeasures.upsertProfile).toHaveBeenCalledTimes(13);
    const profiles = productMeasures.upsertProfile.mock.calls.map(([profile]) => profile);
    expect(profiles.find((profile) => profile.key === "one-piece-raw-single")).toEqual({
      ...profiles.find((profile) => profile.key === "pokemon-raw-single"),
      profileId: "pmp_seed_one_piece_raw_single",
      key: "one-piece-raw-single",
      name: "One Piece raw single",
      matchBlueprintId: catalogSeedIds.blueprints.onePieceCardPrint,
    });
    expect(profiles.find((profile) => profile.key === "one-piece-booster-box")).toEqual({
      ...profiles.find((profile) => profile.key === "pokemon-booster-box"),
      profileId: "pmp_seed_one_piece_booster_box",
      key: "one-piece-booster-box",
      name: "One Piece booster box",
      matchBlueprintId: catalogSeedIds.blueprints.onePieceSealedProduct,
      matchCategoryIds: [catalogSeedIds.categories.onePieceBoosterBoxes],
    });
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

    expect(productMeasures.upsertProfile).toHaveBeenCalledTimes(13);
    expect(productMeasures.resolveAllCatalogItemMeasures).toHaveBeenCalledTimes(1);
  });
});

import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedContext } from "../../../support/seed-support/context";

export async function seedProductMeasures(
  services: CatalogServices,
  options: Readonly<{
    resolveExistingCatalogItems?: boolean;
  }> = {},
) {
  await services.productMeasures.upsertProfile({
    profileId: "pmp_seed_pokemon_raw_single",
    key: "pokemon-raw-single",
    name: "Pokemon raw single",
    matchBlueprintId: catalogSeedIds.blueprints.pokemonCardSingle,
    matchSelectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
    ],
    precedence: 10,
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.012,
    unitWeightOunces: 0.064,
    physicalFlags: ["raw-card", "bendable"],
    stackBehavior: "stackable-thickness",
    confidence: "conservative-estimate",
  });

  await services.productMeasures.upsertProfile({
    profileId: "pmp_seed_pokemon_psa_slab",
    key: "pokemon-psa-slab",
    name: "Pokemon PSA slab",
    matchBlueprintId: catalogSeedIds.blueprints.pokemonCardSingle,
    matchSelectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.graded,
      },
      {
        dimensionId: catalogSeedIds.dimensions.gradingCompany.dimensionId,
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.psa,
      },
    ],
    precedence: 20,
    unitLengthInches: 5.375,
    unitWidthInches: 3.25,
    unitHeightInches: 0.375,
    unitWeightOunces: 2.4,
    physicalFlags: ["slab", "rigid"],
    stackBehavior: "stackable-height",
    confidence: "conservative-estimate",
  });

  await services.productMeasures.upsertProfile({
    profileId: "pmp_seed_pokemon_booster_pack",
    key: "pokemon-booster-pack",
    name: "Pokemon booster pack",
    matchBlueprintId: catalogSeedIds.blueprints.pokemonSealedProduct,
    matchCategoryIds: [catalogSeedIds.categories.boosterPacks],
    precedence: 30,
    unitLengthInches: 5,
    unitWidthInches: 2.75,
    unitHeightInches: 0.18,
    unitWeightOunces: 0.9,
    physicalFlags: ["sealed"],
    stackBehavior: "stackable-height",
    confidence: "conservative-estimate",
  });

  await services.productMeasures.upsertProfile({
    profileId: "pmp_seed_pokemon_booster_box",
    key: "pokemon-booster-box",
    name: "Pokemon booster box",
    matchBlueprintId: catalogSeedIds.blueprints.pokemonSealedProduct,
    matchCategoryIds: [catalogSeedIds.categories.boosterBoxes],
    precedence: 40,
    unitLengthInches: 5.5,
    unitWidthInches: 5,
    unitHeightInches: 2.75,
    unitWeightOunces: 27,
    physicalFlags: ["sealed", "rigid"],
    stackBehavior: "non-stackable",
    confidence: "conservative-estimate",
  });

  await services.productMeasures.upsertProfile({
    profileId: "pmp_seed_pokemon_elite_trainer_box",
    key: "pokemon-elite-trainer-box",
    name: "Pokemon Elite Trainer Box",
    matchBlueprintId: catalogSeedIds.blueprints.pokemonSealedProduct,
    matchCategoryIds: [catalogSeedIds.categories.eliteTrainerBoxes],
    precedence: 50,
    unitLengthInches: 7.5,
    unitWidthInches: 6.5,
    unitHeightInches: 3.5,
    unitWeightOunces: 32,
    physicalFlags: ["sealed", "rigid"],
    stackBehavior: "non-stackable",
    confidence: "conservative-estimate",
  });

  if (options.resolveExistingCatalogItems ?? true) {
    await services.productMeasures.resolveAllCatalogItemMeasures(seedContext);
  }
}

import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { CategoryId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";

export type CategoryIds = Record<string, CategoryId>;

export async function seedCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Seeding categories...");
  const result: CategoryIds = {};

  async function createCategory(
    key: string,
    categoryId: CategoryId,
    name: string,
    description: string,
    parentKey?: string,
    displayOrder?: number,
  ): Promise<void> {
    const streamId = `catalog.category-${categoryId}`;

    await sendSeedCommand(services.categories.commandHandler, streamId, {
      type: "CreateCategory",
      categoryId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      parentCategoryId: parentKey ? result[parentKey] : undefined,
      displayOrder: displayOrder ?? 0,
    });

    await sendSeedCommand(services.categories.commandHandler, streamId, {
      type: "PublishCategory",
    });

    result[key] = categoryId;
  }

  await createCategory(
    "pokemon-tcg",
    catalogSeedIds.categories.pokemonTcg as CategoryId,
    "Pokemon TCG",
    "Pokemon Trading Card Game catalog",
  );

  await createCategory(
    "singles",
    catalogSeedIds.categories.singles as CategoryId,
    "Singles",
    "Individual Pokemon cards",
    "pokemon-tcg",
    0,
  );

  await createCategory(
    "sealed-products",
    catalogSeedIds.categories.sealedProducts as CategoryId,
    "Sealed Products",
    "Pokemon booster packs, booster boxes, and boxed sealed products",
    "pokemon-tcg",
    1,
  );

  await createCategory(
    "booster-packs",
    catalogSeedIds.categories.boosterPacks as CategoryId,
    "Booster Packs",
    "Single sealed booster packs",
    "sealed-products",
    0,
  );
  await createCategory(
    "booster-boxes",
    catalogSeedIds.categories.boosterBoxes as CategoryId,
    "Booster Boxes",
    "Factory sealed booster boxes",
    "sealed-products",
    1,
  );
  await createCategory(
    "elite-trainer-boxes",
    catalogSeedIds.categories.eliteTrainerBoxes as CategoryId,
    "Elite Trainer Boxes",
    "Sealed Elite Trainer Box products",
    "sealed-products",
    2,
  );

  await createCategory(
    "by-generation",
    catalogSeedIds.categories.byGeneration as CategoryId,
    "By Generation",
    "Singles organized by Pokemon generation",
    "singles",
    0,
  );
  const generations = [
    ["gen-1", "Generation I", catalogSeedIds.categories.gen1 as CategoryId],
    ["gen-2", "Generation II", catalogSeedIds.categories.gen2 as CategoryId],
    ["gen-3", "Generation III", catalogSeedIds.categories.gen3 as CategoryId],
    ["gen-4", "Generation IV", catalogSeedIds.categories.gen4 as CategoryId],
    ["gen-5", "Generation V", catalogSeedIds.categories.gen5 as CategoryId],
    ["gen-6", "Generation VI", catalogSeedIds.categories.gen6 as CategoryId],
    ["gen-7", "Generation VII", catalogSeedIds.categories.gen7 as CategoryId],
    ["gen-8", "Generation VIII", catalogSeedIds.categories.gen8 as CategoryId],
    ["gen-9", "Generation IX", catalogSeedIds.categories.gen9 as CategoryId],
  ] as const;
  for (let index = 0; index < generations.length; index += 1) {
    await createCategory(
      generations[index][0],
      generations[index][2],
      generations[index][1],
      `${generations[index][1]} Pokemon singles`,
      "by-generation",
      index,
    );
  }

  await createCategory(
    "by-type",
    catalogSeedIds.categories.byType as CategoryId,
    "By Type",
    "Singles organized by Pokemon type",
    "singles",
    1,
  );
  const types = [
    ["Fire", catalogSeedIds.categories.fire as CategoryId],
    ["Water", catalogSeedIds.categories.water as CategoryId],
    ["Grass", catalogSeedIds.categories.grass as CategoryId],
    ["Electric", catalogSeedIds.categories.electric as CategoryId],
    ["Psychic", catalogSeedIds.categories.psychic as CategoryId],
    ["Fighting", catalogSeedIds.categories.fighting as CategoryId],
    ["Dark", catalogSeedIds.categories.dark as CategoryId],
    ["Metal", catalogSeedIds.categories.metal as CategoryId],
    ["Dragon", catalogSeedIds.categories.dragon as CategoryId],
    ["Fairy", catalogSeedIds.categories.fairy as CategoryId],
    ["Normal", catalogSeedIds.categories.normal as CategoryId],
    ["Colorless", catalogSeedIds.categories.colorless as CategoryId],
  ] as const;
  for (let index = 0; index < types.length; index += 1) {
    const key = types[index][0].toLowerCase();
    await createCategory(
      key,
      types[index][1],
      types[index][0],
      `${types[index][0]} type Pokemon singles`,
      "by-type",
      index,
    );
  }

  await createCategory(
    "trainer-cards",
    catalogSeedIds.categories.trainerCards as CategoryId,
    "Trainer Cards",
    "Trainer, Supporter, and Stadium singles",
    "singles",
    2,
  );
  await createCategory(
    "energy-cards",
    catalogSeedIds.categories.energyCards as CategoryId,
    "Energy Cards",
    "Basic and Special Energy singles",
    "singles",
    3,
  );

  console.log(`  ${Object.keys(result).length} categories created`);
  return result;
}

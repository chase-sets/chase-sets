import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { CategoryId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";

export type CategoryIds = Record<string, CategoryId>;

type CategoryDef = Readonly<{
  key: string;
  categoryId: CategoryId;
  name: string;
  description: string;
  parentKey?: string;
  displayOrder?: number;
}>;

export async function seedCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Seeding categories...");
  const result = await seedCategoryDefinitions(services, allCategoryDefs());

  console.log(`  ${Object.keys(result).length} categories created`);
  return result;
}

export async function seedMagicCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Reconciling Magic categories...");
  return seedCategoryDefinitions(
    services,
    allCategoryDefs().filter((def) => def.key.startsWith("magic-")),
    { reconcileExisting: true },
  );
}

function allCategoryDefs(): CategoryDef[] {
  const defs: CategoryDef[] = [
    {
      key: "pokemon-tcg",
      categoryId: catalogSeedIds.categories.pokemonTcg as CategoryId,
      name: "Pokemon TCG",
      description: "Pokemon Trading Card Game catalog",
    },
    {
      key: "singles",
      categoryId: catalogSeedIds.categories.singles as CategoryId,
      name: "Singles",
      description: "Individual Pokemon cards",
      parentKey: "pokemon-tcg",
      displayOrder: 0,
    },
    {
      key: "sealed-products",
      categoryId: catalogSeedIds.categories.sealedProducts as CategoryId,
      name: "Sealed Products",
      description: "Pokemon booster packs, booster boxes, and boxed sealed products",
      parentKey: "pokemon-tcg",
      displayOrder: 1,
    },
    {
      key: "booster-packs",
      categoryId: catalogSeedIds.categories.boosterPacks as CategoryId,
      name: "Booster Packs",
      description: "Single sealed booster packs",
      parentKey: "sealed-products",
      displayOrder: 0,
    },
    {
      key: "booster-boxes",
      categoryId: catalogSeedIds.categories.boosterBoxes as CategoryId,
      name: "Booster Boxes",
      description: "Factory sealed booster boxes",
      parentKey: "sealed-products",
      displayOrder: 1,
    },
    {
      key: "elite-trainer-boxes",
      categoryId: catalogSeedIds.categories.eliteTrainerBoxes as CategoryId,
      name: "Elite Trainer Boxes",
      description: "Sealed Elite Trainer Box products",
      parentKey: "sealed-products",
      displayOrder: 2,
    },
    {
      key: "by-generation",
      categoryId: catalogSeedIds.categories.byGeneration as CategoryId,
      name: "By Generation",
      description: "Singles organized by Pokemon generation",
      parentKey: "singles",
      displayOrder: 0,
    },
  ];

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
    defs.push({
      key: generations[index][0],
      categoryId: generations[index][2],
      name: generations[index][1],
      description: `${generations[index][1]} Pokemon singles`,
      parentKey: "by-generation",
      displayOrder: index,
    });
  }

  defs.push({
    key: "by-type",
    categoryId: catalogSeedIds.categories.byType as CategoryId,
    name: "By Type",
    description: "Singles organized by Pokemon type",
    parentKey: "singles",
    displayOrder: 1,
  });

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
    defs.push({
      key: types[index][0].toLowerCase(),
      categoryId: types[index][1],
      name: types[index][0],
      description: `${types[index][0]} type Pokemon singles`,
      parentKey: "by-type",
      displayOrder: index,
    });
  }

  defs.push(
    {
      key: "trainer-cards",
      categoryId: catalogSeedIds.categories.trainerCards as CategoryId,
      name: "Trainer Cards",
      description: "Trainer, Supporter, and Stadium singles",
      parentKey: "singles",
      displayOrder: 2,
    },
    {
      key: "energy-cards",
      categoryId: catalogSeedIds.categories.energyCards as CategoryId,
      name: "Energy Cards",
      description: "Basic and Special Energy singles",
      parentKey: "singles",
      displayOrder: 3,
    },
    {
      key: "magic-the-gathering",
      categoryId: catalogSeedIds.categories.magicTheGathering as CategoryId,
      name: "Magic: The Gathering",
      description: "Magic: The Gathering catalog",
    },
    {
      key: "magic-card-prints",
      categoryId: catalogSeedIds.categories.magicCardPrints as CategoryId,
      name: "Card Prints",
      description: "Individual Magic card prints",
      parentKey: "magic-the-gathering",
      displayOrder: 0,
    },
    {
      key: "magic-sealed-products",
      categoryId: catalogSeedIds.categories.magicSealedProducts as CategoryId,
      name: "Sealed Products",
      description: "Magic sealed products",
      parentKey: "magic-the-gathering",
      displayOrder: 1,
    },
    {
      key: "magic-booster-packs",
      categoryId: catalogSeedIds.categories.magicBoosterPacks as CategoryId,
      name: "Booster Packs",
      description: "Single sealed Magic booster packs",
      parentKey: "magic-sealed-products",
      displayOrder: 0,
    },
    {
      key: "magic-booster-boxes",
      categoryId: catalogSeedIds.categories.magicBoosterBoxes as CategoryId,
      name: "Booster Boxes",
      description: "Factory sealed Magic booster boxes",
      parentKey: "magic-sealed-products",
      displayOrder: 1,
    },
  );

  return defs;
}

async function seedCategoryDefinitions(
  services: CatalogServices,
  defs: readonly CategoryDef[],
  options: Readonly<{ reconcileExisting?: boolean }> = {},
): Promise<CategoryIds> {
  const result: CategoryIds = Object.fromEntries(defs.map((def) => [def.key, def.categoryId]));

  for (const def of defs) {
    if (options.reconcileExisting && (await categoryExists(services, def))) {
      continue;
    }

    const streamId = `catalog.category-${def.categoryId}`;

    await sendSeedCommand(services.categories.commandHandler, streamId, {
      type: "CreateCategory",
      categoryId: def.categoryId,
      key: def.key,
      name: localizedTextMapFromEnglish(def.name),
      description: localizedTextMapFromEnglish(def.description),
      parentCategoryId: def.parentKey ? result[def.parentKey] : undefined,
      displayOrder: def.displayOrder ?? 0,
    });

    await sendSeedCommand(services.categories.commandHandler, streamId, {
      type: "PublishCategory",
    });
  }

  return result;
}

async function categoryExists(services: CatalogServices, def: CategoryDef): Promise<boolean> {
  const existing = await services.db.query<{ category_id: string; key: string; status: string }>(
    `SELECT category_id, key, status
     FROM catalog_categories
     WHERE category_id = $1 OR key = $2`,
    [def.categoryId, def.key],
  );
  const row = existing.rows.find((candidate) => candidate.category_id === def.categoryId);
  if (existing.rows.length === 0) {
    return false;
  }
  if (!row || row.key !== def.key || existing.rows.length > 1) {
    throw new Error(`Catalog integration bootstrap category '${def.key}' conflicts with existing metadata.`);
  }
  if (row.status !== "active") {
    throw new Error(`Catalog integration bootstrap requires active category '${def.key}'.`);
  }
  return true;
}

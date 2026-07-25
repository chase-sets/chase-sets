import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { CategoryId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { loadSeedAggregateState } from "../../../support/seed-support/aggregate-state";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import {
  decideCategory,
  evolveCategory,
  initialCategoryState,
  type CategoryCommand,
  type CategoryEvent,
  type CategoryState,
} from "../domain/domain";

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

export async function seedOnePieceCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Reconciling One Piece categories...");
  return seedCategoryDefinitions(
    services,
    allCategoryDefs().filter((def) => def.key.startsWith("one-piece-")),
    { reconcileExisting: true },
  );
}

export async function seedLorcanaCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Reconciling Lorcana categories...");
  return seedCategoryDefinitions(
    services,
    allCategoryDefs().filter((def) => def.key.startsWith("lorcana")),
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
    {
      key: "one-piece-card-game",
      categoryId: catalogSeedIds.categories.onePieceCardGame as CategoryId,
      name: "One Piece Card Game",
      description: "One Piece Card Game catalog",
    },
    {
      key: "one-piece-card-prints",
      categoryId: catalogSeedIds.categories.onePieceCardPrints as CategoryId,
      name: "Card Prints",
      description: "Individual One Piece card prints",
      parentKey: "one-piece-card-game",
      displayOrder: 0,
    },
    {
      key: "one-piece-sealed-products",
      categoryId: catalogSeedIds.categories.onePieceSealedProducts as CategoryId,
      name: "Sealed Products",
      description: "One Piece sealed products",
      parentKey: "one-piece-card-game",
      displayOrder: 1,
    },
    {
      key: "one-piece-booster-packs",
      categoryId: catalogSeedIds.categories.onePieceBoosterPacks as CategoryId,
      name: "Booster Packs",
      description: "Single sealed One Piece booster packs",
      parentKey: "one-piece-sealed-products",
      displayOrder: 0,
    },
    {
      key: "one-piece-booster-boxes",
      categoryId: catalogSeedIds.categories.onePieceBoosterBoxes as CategoryId,
      name: "Booster Boxes",
      description: "Factory sealed One Piece booster boxes",
      parentKey: "one-piece-sealed-products",
      displayOrder: 1,
    },
    {
      key: "one-piece-starter-decks",
      categoryId: catalogSeedIds.categories.onePieceStarterDecks as CategoryId,
      name: "Starter Decks",
      description: "Factory sealed One Piece starter decks",
      parentKey: "one-piece-sealed-products",
      displayOrder: 2,
    },
    {
      key: "lorcana",
      categoryId: catalogSeedIds.categories.lorcana as CategoryId,
      name: "Disney Lorcana",
      description: "Disney Lorcana catalog",
    },
    {
      key: "lorcana-sets",
      categoryId: catalogSeedIds.categories.lorcanaSets as CategoryId,
      name: "Sets / Chapters",
      description: "Disney Lorcana sets, chapters, and release groups",
      parentKey: "lorcana",
      displayOrder: 0,
    },
    {
      key: "lorcana-special-sets",
      categoryId: catalogSeedIds.categories.lorcanaSpecialSets as CategoryId,
      name: "Promo / Special Sets",
      description: "Disney Lorcana promo and special release groups",
      parentKey: "lorcana-sets",
      displayOrder: 1,
    },
    {
      key: "lorcana-card-prints",
      categoryId: catalogSeedIds.categories.lorcanaCardPrints as CategoryId,
      name: "Card Prints",
      description: "Individual Disney Lorcana card prints",
      parentKey: "lorcana",
      displayOrder: 1,
    },
    {
      key: "lorcana-sealed-products",
      categoryId: catalogSeedIds.categories.lorcanaSealedProducts as CategoryId,
      name: "Sealed Products",
      description: "Disney Lorcana sealed products",
      parentKey: "lorcana",
      displayOrder: 2,
    },
    {
      key: "lorcana-booster-packs",
      categoryId: catalogSeedIds.categories.lorcanaBoosterPacks as CategoryId,
      name: "Booster Packs",
      description: "Single sealed Disney Lorcana booster packs",
      parentKey: "lorcana-sealed-products",
      displayOrder: 0,
    },
    {
      key: "lorcana-sleeved-boosters",
      categoryId: catalogSeedIds.categories.lorcanaSleevedBoosters as CategoryId,
      name: "Sleeved Boosters",
      description: "Single sealed Disney Lorcana sleeved booster packs",
      parentKey: "lorcana-sealed-products",
      displayOrder: 1,
    },
    {
      key: "lorcana-booster-boxes",
      categoryId: catalogSeedIds.categories.lorcanaBoosterBoxes as CategoryId,
      name: "Booster Boxes / Displays",
      description: "Factory sealed Disney Lorcana booster boxes and displays",
      parentKey: "lorcana-sealed-products",
      displayOrder: 2,
    },
    {
      key: "lorcana-booster-cases",
      categoryId: catalogSeedIds.categories.lorcanaBoosterCases as CategoryId,
      name: "Booster Cases",
      description: "Factory sealed Disney Lorcana booster display cases",
      parentKey: "lorcana-sealed-products",
      displayOrder: 3,
    },
    {
      key: "lorcana-starter-decks",
      categoryId: catalogSeedIds.categories.lorcanaStarterDecks as CategoryId,
      name: "Starter Decks / Sets",
      description: "Factory sealed Disney Lorcana starter decks and starter sets",
      parentKey: "lorcana-sealed-products",
      displayOrder: 4,
    },
    {
      key: "lorcana-troves",
      categoryId: catalogSeedIds.categories.lorcanaTrove as CategoryId,
      name: "Illumineer's Troves",
      description: "Factory sealed Disney Lorcana Illumineer's Troves",
      parentKey: "lorcana-sealed-products",
      displayOrder: 5,
    },
    {
      key: "lorcana-gift-sets",
      categoryId: catalogSeedIds.categories.lorcanaGiftSets as CategoryId,
      name: "Gift Sets",
      description: "Factory sealed Disney Lorcana gift sets",
      parentKey: "lorcana-sealed-products",
      displayOrder: 6,
    },
    {
      key: "lorcana-collection-starters",
      categoryId: catalogSeedIds.categories.lorcanaCollectionStarters as CategoryId,
      name: "Collection Starters",
      description: "Factory sealed Disney Lorcana collection starter products",
      parentKey: "lorcana-sealed-products",
      displayOrder: 7,
    },
    {
      key: "lorcana-prerelease-boxes",
      categoryId: catalogSeedIds.categories.lorcanaPrereleaseBoxes as CategoryId,
      name: "Prerelease Boxes",
      description: "Factory sealed Disney Lorcana prerelease boxes",
      parentKey: "lorcana-sealed-products",
      displayOrder: 8,
    },
    {
      key: "lorcana-quests-and-product-bundles",
      categoryId: catalogSeedIds.categories.lorcanaQuestsAndProductBundles as CategoryId,
      name: "Quests / Product Bundles",
      description: "Disney Lorcana quest boxes and sealed product bundles",
      parentKey: "lorcana-sealed-products",
      displayOrder: 9,
    },
  );

  return defs;
}

export const categorySeedRequirements = allCategoryDefs().map((def) => ({
  aggregateName: "Category",
  id: def.categoryId,
  key: def.key,
  streamId: `catalog.category-${def.categoryId}`,
})) as readonly Readonly<{ aggregateName: "Category"; id: CategoryId; key: string; streamId: string }>[];

async function seedCategoryDefinitions(
  services: CatalogServices,
  defs: readonly CategoryDef[],
  options: Readonly<{ reconcileExisting?: boolean }> = {},
): Promise<CategoryIds> {
  const result: CategoryIds = Object.fromEntries(defs.map((def) => [def.key, def.categoryId]));
  const states = new Map<string, CategoryState>();

  for (const def of defs) {
    if (options.reconcileExisting && (await categoryExists(services, def))) {
      continue;
    }

    const streamId = `catalog.category-${def.categoryId}`;

    await sendCategorySeedCommand(services, states, def, streamId, {
      type: "CreateCategory",
      categoryId: def.categoryId,
      key: def.key,
      name: localizedTextMapFromEnglish(def.name),
      description: localizedTextMapFromEnglish(def.description),
      parentCategoryId: def.parentKey ? result[def.parentKey] : undefined,
      displayOrder: def.displayOrder ?? 0,
    });

    await sendCategorySeedCommand(services, states, def, streamId, {
      type: "PublishCategory",
    });
  }

  return result;
}

async function categoryExists(services: CatalogServices, def: CategoryDef): Promise<boolean> {
  const aggregate = await loadCategorySeedState(services, def);
  return aggregate.kind === "active";
}

async function sendCategorySeedCommand(
  services: CatalogServices,
  states: Map<string, CategoryState>,
  def: CategoryDef,
  streamId: string,
  command: CategoryCommand,
): Promise<void> {
  const persisted = states.has(streamId) ? undefined : await loadCategorySeedState(services, def);
  const state = states.get(streamId) ?? persisted?.state ?? initialCategoryState;
  const kind = persisted?.kind ?? (state.id === null ? "absent" : state.status === "active" ? "active" : "draft");
  states.set(streamId, state);
  if (kind === "active") {
    return;
  }
  if (command.type === "CreateCategory" && kind === "draft") {
    return;
  }
  if (command.type !== "CreateCategory" && kind === "absent") {
    throw new Error(`Catalog integration bootstrap Category '${def.key}' must be created before '${command.type}'.`);
  }
  await sendSeedCommand(services.categories.commandHandler, streamId, command);
  states.set(streamId, decideCategory(state, command).reduce(evolveCategory, state));
}

function loadCategorySeedState(services: CatalogServices, def: CategoryDef) {
  return loadSeedAggregateState<typeof initialCategoryState, CategoryEvent>({
    db: services.db,
    aggregateName: "Category",
    streamId: `catalog.category-${def.categoryId}`,
    createdEventType: "catalog.category.created",
    createdIdField: "categoryId",
    expectedId: def.categoryId,
    expectedKey: def.key,
    initialState: initialCategoryState,
    evolve: evolveCategory,
  });
}

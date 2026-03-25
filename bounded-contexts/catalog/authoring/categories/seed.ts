import { createId } from "../../../../contracts/primitives/typed-ids";
import type { CatalogServices } from "../api/services";
import type { CategoryId } from "../../ids";
import { sendSeedCommand } from "../seed-support";

export type CategoryIds = Record<string, CategoryId>;

export async function seedCategories(services: CatalogServices): Promise<CategoryIds> {
  console.log("Seeding categories...");
  const result: CategoryIds = {};

  async function createCategory(
    key: string,
    name: string,
    description: string,
    parentKey?: string,
    displayOrder?: number,
  ): Promise<void> {
    const categoryId = createId("ctg") as CategoryId;
    const streamId = `catalog.category-${categoryId}`;

    await sendSeedCommand(services.categoryHandler, streamId, {
      type: "CreateCategory",
      categoryId,
      key,
      name,
      description,
      parentCategoryId: parentKey ? result[parentKey] : undefined,
      displayOrder: displayOrder ?? 0,
    });

    await sendSeedCommand(services.categoryHandler, streamId, {
      type: "PublishCategory",
    });

    result[key] = categoryId;
  }

  await createCategory(
    "pokemon-tcg",
    "Pokemon TCG",
    "Pokemon Trading Card Game",
  );

  await createCategory(
    "by-generation",
    "By Generation",
    "Cards organized by Pokemon generation",
    "pokemon-tcg",
    0,
  );
  const generations = [
    ["gen-1", "Generation I"],
    ["gen-2", "Generation II"],
    ["gen-3", "Generation III"],
    ["gen-4", "Generation IV"],
    ["gen-5", "Generation V"],
    ["gen-6", "Generation VI"],
    ["gen-7", "Generation VII"],
    ["gen-8", "Generation VIII"],
    ["gen-9", "Generation IX"],
  ] as const;
  for (let index = 0; index < generations.length; index += 1) {
    await createCategory(
      generations[index][0],
      generations[index][1],
      `${generations[index][1]} Pokemon cards`,
      "by-generation",
      index,
    );
  }

  await createCategory(
    "by-type",
    "By Type",
    "Cards organized by Pokemon type",
    "pokemon-tcg",
    1,
  );
  const types = [
    "Fire",
    "Water",
    "Grass",
    "Electric",
    "Psychic",
    "Fighting",
    "Dark",
    "Metal",
    "Dragon",
    "Fairy",
    "Normal",
    "Colorless",
  ] as const;
  for (let index = 0; index < types.length; index += 1) {
    const key = types[index].toLowerCase();
    await createCategory(
      key,
      types[index],
      `${types[index]} type Pokemon cards`,
      "by-type",
      index,
    );
  }

  await createCategory(
    "trainer-cards",
    "Trainer Cards",
    "Trainer, Supporter, and Stadium cards",
    "pokemon-tcg",
    2,
  );
  await createCategory(
    "energy-cards",
    "Energy Cards",
    "Basic and Special Energy cards",
    "pokemon-tcg",
    3,
  );

  console.log(`  ${Object.keys(result).length} categories created`);
  return result;
}
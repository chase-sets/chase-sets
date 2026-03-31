import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
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

    await sendSeedCommand(services.categories.commandHandler, streamId, {
      type: "CreateCategory",
      categoryId,
      key,
      name,
      description,
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
    "Pokemon TCG",
    "Pokemon Trading Card Game catalog",
  );

  await createCategory(
    "singles",
    "Singles",
    "Individual Pokemon cards",
    "pokemon-tcg",
    0,
  );

  await createCategory(
    "sealed-products",
    "Sealed Products",
    "Pokemon booster packs, booster boxes, and boxed sealed products",
    "pokemon-tcg",
    1,
  );

  await createCategory(
    "booster-packs",
    "Booster Packs",
    "Single sealed booster packs",
    "sealed-products",
    0,
  );
  await createCategory(
    "booster-boxes",
    "Booster Boxes",
    "Factory sealed booster boxes",
    "sealed-products",
    1,
  );
  await createCategory(
    "elite-trainer-boxes",
    "Elite Trainer Boxes",
    "Sealed Elite Trainer Box products",
    "sealed-products",
    2,
  );

  await createCategory(
    "by-generation",
    "By Generation",
    "Singles organized by Pokemon generation",
    "singles",
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
      `${generations[index][1]} Pokemon singles`,
      "by-generation",
      index,
    );
  }

  await createCategory(
    "by-type",
    "By Type",
    "Singles organized by Pokemon type",
    "singles",
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
      `${types[index]} type Pokemon singles`,
      "by-type",
      index,
    );
  }

  await createCategory(
    "trainer-cards",
    "Trainer Cards",
    "Trainer, Supporter, and Stadium singles",
    "singles",
    2,
  );
  await createCategory(
    "energy-cards",
    "Energy Cards",
    "Basic and Special Energy singles",
    "singles",
    3,
  );

  console.log(`  ${Object.keys(result).length} categories created`);
  return result;
}

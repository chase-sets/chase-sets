import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CategoryCommand, CreateCategoryCommand } from "../domain/domain";
import { seedCategories, seedLorcanaCategories, seedOnePieceCategories } from "./seed";

describe("category seed", () => {
  it("seeds single-card categories as Singles", async () => {
    const categories: CreateCategoryCommand[] = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      categories: {
        commandHandler: async ({ command }: { command: CategoryCommand }) => {
          if (command.type === "CreateCategory") {
            categories.push(command);
          }
        },
      },
    };

    await seedCategories(services as never);

    const namesByKey = Object.fromEntries(categories.map(({ key, name }) => [key, name.values.en]));
    expect(namesByKey).toMatchObject({
      "magic-card-prints": "Singles",
      "one-piece-card-prints": "Singles",
      "lorcana-card-prints": "Singles",
    });
    expect(Object.values(namesByKey)).not.toContain("Card Prints");
  });

  it("seeds the One Piece category branch with stable parentage", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      categories: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    const ids = await seedOnePieceCategories(services as never);

    expect(ids["one-piece-card-game"]).toBe(catalogSeedIds.categories.onePieceCardGame);
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.category-${catalogSeedIds.categories.onePieceCardGame}`,
        command: expect.objectContaining({
          type: "CreateCategory",
          key: "one-piece-card-game",
          parentCategoryId: undefined,
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.category-${catalogSeedIds.categories.onePieceBoosterBoxes}`,
        command: expect.objectContaining({
          type: "CreateCategory",
          key: "one-piece-booster-boxes",
          parentCategoryId: catalogSeedIds.categories.onePieceSealedProducts,
          displayOrder: 1,
        }),
      }),
    );
  });

  it("seeds Lorcana set and sealed product taxonomy forms with stable parentage", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      categories: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    const ids = await seedLorcanaCategories(services as never);

    expect(ids.lorcana).toBe(catalogSeedIds.categories.lorcana);
    expect(ids["lorcana-special-sets"]).toBe(catalogSeedIds.categories.lorcanaSpecialSets);
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.category-${catalogSeedIds.categories.lorcanaSpecialSets}`,
        command: expect.objectContaining({
          type: "CreateCategory",
          key: "lorcana-special-sets",
          parentCategoryId: catalogSeedIds.categories.lorcanaSets,
        }),
      }),
    );
    expect(commands).toEqual(
      expect.arrayContaining(
        [
          ["lorcana-booster-packs", catalogSeedIds.categories.lorcanaSealedProducts, 0],
          ["lorcana-sleeved-boosters", catalogSeedIds.categories.lorcanaSealedProducts, 1],
          ["lorcana-booster-boxes", catalogSeedIds.categories.lorcanaSealedProducts, 2],
          ["lorcana-booster-cases", catalogSeedIds.categories.lorcanaSealedProducts, 3],
          ["lorcana-starter-decks", catalogSeedIds.categories.lorcanaSealedProducts, 4],
          ["lorcana-troves", catalogSeedIds.categories.lorcanaSealedProducts, 5],
          ["lorcana-gift-sets", catalogSeedIds.categories.lorcanaSealedProducts, 6],
          ["lorcana-collection-starters", catalogSeedIds.categories.lorcanaSealedProducts, 7],
          ["lorcana-prerelease-boxes", catalogSeedIds.categories.lorcanaSealedProducts, 8],
          ["lorcana-quests-and-product-bundles", catalogSeedIds.categories.lorcanaSealedProducts, 9],
        ].map(([key, parentCategoryId, displayOrder]) =>
          expect.objectContaining({
            command: expect.objectContaining({
              type: "CreateCategory",
              key,
              parentCategoryId,
              displayOrder,
            }),
          }),
        ),
      ),
    );
  });
});

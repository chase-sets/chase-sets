import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedOnePieceCategories } from "./seed";

describe("category seed", () => {
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
});

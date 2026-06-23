import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedCatalogItems } from "./seed";

describe("catalog item seed", () => {
  it("attaches Scrydex and TCGplayer identities to the same One Piece card Catalog Item", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      items: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    await seedCatalogItems(
      services as never,
      keyBackedIds("bpr") as never,
      keyBackedIds("fld") as never,
      keyBackedIds("ctg") as never,
      referenceIds() as never,
    );

    const itemStreamId = `catalog.item-${catalogSeedIds.items.onePieceLuffyRomanceDawn}`;
    const itemCommands = commands.filter((entry) => entry.streamId === itemStreamId).map((entry) => entry.command);

    expect(itemCommands.filter((command) => command.type === "CreateCatalogItem")).toHaveLength(1);
    expect(itemCommands).toContainEqual(
      expect.objectContaining({
        type: "AssignBlueprintToCatalogItem",
        blueprintId: "bpr_one-piece-card-print",
      }),
    );
    expect(itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "scrydex",
          externalKey: "card:op01-001",
        }),
        expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:987650",
        }),
        expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:900987650",
          selectedOptions: [
            {
              dimensionId: catalogSeedIds.dimensions.form.dimensionId,
              optionId: catalogSeedIds.dimensions.form.optionIds.raw,
            },
            {
              dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
              optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
            },
          ],
        }),
      ]),
    );
  });
});

function keyBackedIds(prefix: string): Record<string, string> {
  return new Proxy(
    {},
    {
      get: (_target, property) => `${prefix}_${String(property)}`,
    },
  ) as Record<string, string>;
}

function referenceIds() {
  return {
    expansions: keyBackedIds("ref_expansion"),
    magic: {
      sets: keyBackedIds("ref_magic_set"),
    },
    onePiece: {
      sets: keyBackedIds("ref_one_piece_set"),
    },
  };
}

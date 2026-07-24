import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedCatalogItems } from "./seed";

describe("catalog item seed", () => {
  it("keeps every seeded card-number value aligned with its product-line collector-number semantics", async () => {
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

    const expectedCardNumbers = new Map<string, string>([
      [catalogSeedIds.items.charizardBaseSet, "4"],
      [catalogSeedIds.items.pikachuJungle, "60"],
      [catalogSeedIds.items.japaneseCharizardBaseSet, "No.006"],
      [catalogSeedIds.items.lugiaNeoGenesis, "9"],
      [catalogSeedIds.items.mewtwoBlackStarPromo, "3"],
      [catalogSeedIds.items.bulbasaurBaseSet, "44"],
      [catalogSeedIds.items.pikachuPrismaticEvolutions, "025"],
      [catalogSeedIds.items.onePieceLuffyRomanceDawn, "OP01-001"],
      [catalogSeedIds.items.lorcanaElsaSnowQueen, "41/204"],
    ]);
    const seededCardNumbers = commands
      .filter(
        (entry) => entry.command.type === "SetCatalogItemFieldValue" && entry.command.fieldId === "fld_card-number",
      )
      .map((entry) => [entry.streamId.replace("catalog.item-", ""), String(entry.command.value)] as const);

    expect(new Map(seededCardNumbers)).toEqual(expectedCardNumbers);
  });

  it("can seed only the representative Product Contents Catalog Items", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      items: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };
    const representativeCatalogItemIds = [
      catalogSeedIds.items.prismaticEvolutionsBoosterPack,
      catalogSeedIds.items.pikachuPrismaticEvolutions,
    ];

    await seedCatalogItems(
      services as never,
      keyBackedIds("bpr") as never,
      keyBackedIds("fld") as never,
      keyBackedIds("ctg") as never,
      referenceIds() as never,
      { catalogItemIds: representativeCatalogItemIds as never },
    );

    const createdCatalogItemIds = commands
      .filter((entry) => entry.command.type === "CreateCatalogItem")
      .map((entry) => String(entry.command.itemId));
    expect(createdCatalogItemIds).toHaveLength(representativeCatalogItemIds.length);
    expect(createdCatalogItemIds).toEqual(expect.arrayContaining(representativeCatalogItemIds));
    for (const catalogItemId of representativeCatalogItemIds) {
      expect(commands).toContainEqual(
        expect.objectContaining({
          streamId: `catalog.item-${catalogItemId}`,
          command: expect.objectContaining({ type: "PublishCatalogItem" }),
        }),
      );
    }
  });

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

  it("seeds a Lorcana card print with variant, ink, type, classifications, properties, and artist fields", async () => {
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

    const itemStreamId = `catalog.item-${catalogSeedIds.items.lorcanaElsaSnowQueen}`;
    const itemCommands = commands.filter((entry) => entry.streamId === itemStreamId).map((entry) => entry.command);

    expect(itemCommands).toContainEqual(
      expect.objectContaining({
        type: "AssignBlueprintToCatalogItem",
        blueprintId: "bpr_lorcana-card-print",
      }),
    );
    expect(itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_set",
          value: { referenceId: "ref_lorcana_set_the-first-chapter" },
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_card-variant",
          value: "Standard",
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_ink-color",
          value: "Amethyst",
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_card-type",
          value: "Character",
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_card-classifications",
          value: ["Storyborn", "Hero", "Queen"],
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_card-properties",
          value: ["Frozen"],
        }),
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_card-illustrator",
          value: "Nicholas Kole",
        }),
        expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "lorcanajson",
          externalKey: "card:1-041",
        }),
        expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "lorcast",
          externalKey: "card:crd_elsa_snow_queen_1_041",
        }),
      ]),
    );
  });

  it("seeds a Lorcana sealed booster display with sealed form taxonomy", async () => {
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

    const itemStreamId = `catalog.item-${catalogSeedIds.items.lorcanaTheFirstChapterBoosterBox}`;
    const itemCommands = commands.filter((entry) => entry.streamId === itemStreamId).map((entry) => entry.command);

    expect(itemCommands).toContainEqual(
      expect.objectContaining({
        type: "AssignBlueprintToCatalogItem",
        blueprintId: "bpr_lorcana-sealed-product",
      }),
    );
    expect(itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_sealed-product-form",
          value: "booster-box-display",
        }),
        expect.objectContaining({
          type: "AssignCatalogItemToCategory",
          categoryId: "ctg_lorcana-booster-boxes",
        }),
        expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:1005020",
        }),
        expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:9001005020",
          selectedOptions: [],
        }),
        expect.objectContaining({
          type: "PublishCatalogItem",
          requiredFieldIds: ["fld_set", "fld_sealed-product-form"],
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
    lorcana: {
      sets: keyBackedIds("ref_lorcana_set"),
    },
  };
}

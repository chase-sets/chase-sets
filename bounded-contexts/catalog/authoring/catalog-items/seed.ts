import { catalogSeedIds } from "../seed-support/ids";
import type { CatalogServices } from "../services";
import type { CatalogItemId, FieldId } from "../../ids";
import { sendSeedCommand } from "../seed-support/context";
import type { BlueprintIds } from "../blueprints/seed";
import type { CategoryIds } from "../categories/seed";
import type { FieldIds } from "../fields/seed";

export async function seedCatalogItems(
  services: CatalogServices,
  blueprints: BlueprintIds,
  fields: FieldIds,
  categories: CategoryIds,
): Promise<void> {
  console.log("Seeding catalog items...");

  const requiredFieldIdsByBlueprint: Record<string, readonly FieldId[]> = {
    "pokemon-card-single": [
      fields["card-number"],
      fields["card-name"],
      fields["set-name"],
      fields.rarity,
      fields.language,
    ],
    "pokemon-sealed-product": [
      fields["set-name"],
      fields.language,
      fields["pack-count"],
    ],
  };

  type ItemDef = {
    itemId: CatalogItemId;
    title: string;
    subtitle: string;
    description: string;
    blueprintKey: string;
    fieldValues: [string, string | number][];
    categoryKeys: string[];
    tags: string[];
  };

  const items: ItemDef[] = [
    {
      itemId: catalogSeedIds.items.charizardBaseSet as CatalogItemId,
      title: "Charizard",
      subtitle: "Base Set 4/102 Holo Rare",
      description:
        "The iconic Base Set Charizard, seeded as a single catalog item whose sellable versions vary by form, condition, and grade.",
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", "Charizard"],
        ["set-name", "Base Set"],
        ["rarity", "Holo Rare"],
        ["language", "English"],
        ["artist", "Mitsuhiro Arita"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "fire"],
      tags: ["base-set", "charizard", "holo", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.pikachuJungle as CatalogItemId,
      title: "Pikachu",
      subtitle: "Jungle 60/64 Common",
      description:
        "A classic Jungle Pikachu seeded as one catalog item instead of separate raw and graded items.",
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "60/64"],
        ["card-name", "Pikachu"],
        ["set-name", "Jungle"],
        ["rarity", "Common"],
        ["language", "English"],
        ["artist", "Kagemaru Himeno"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "electric"],
      tags: ["jungle", "pikachu", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.lugiaNeoGenesis as CatalogItemId,
      title: "Lugia",
      subtitle: "Neo Genesis 9/111 Holo Rare",
      description:
        "A Neo Genesis Lugia single whose raw and graded variants resolve from the same catalog item.",
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "9/111"],
        ["card-name", "Lugia"],
        ["set-name", "Neo Genesis"],
        ["rarity", "Holo Rare"],
        ["language", "English"],
        ["artist", "Hironobu Yoshida"],
        ["release-year", 2000],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-2", "psychic"],
      tags: ["lugia", "neo-genesis", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.pikachuPrismaticEvolutions as CatalogItemId,
      title: "Pikachu",
      subtitle: "Prismatic Evolutions 025 Illustration Rare",
      description:
        "A modern Pikachu single from Prismatic Evolutions with form-driven versioning instead of duplicated raw and graded catalog entries.",
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "025"],
        ["card-name", "Pikachu"],
        ["set-name", "Prismatic Evolutions"],
        ["rarity", "Illustration Rare"],
        ["language", "English"],
        ["artist", "Ryuta Fuse"],
        ["release-year", 2025],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-9", "electric"],
      tags: ["modern", "pikachu", "prismatic-evolutions"],
    },
    {
      itemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack as CatalogItemId,
      title: "Prismatic Evolutions Booster Pack",
      subtitle: "Sealed booster pack",
      description:
        "A single sealed booster pack from the Prismatic Evolutions set.",
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Prismatic Evolutions"],
        ["language", "English"],
        ["release-year", 2025],
        ["pack-count", 1],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-packs"],
      tags: ["booster-pack", "prismatic-evolutions", "sealed"],
    },
    {
      itemId: catalogSeedIds.items.surgingSparksBoosterBox as CatalogItemId,
      title: "Surging Sparks Booster Box",
      subtitle: "Sealed booster box",
      description:
        "A factory sealed Surging Sparks booster box containing 36 packs.",
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Surging Sparks"],
        ["language", "English"],
        ["release-year", 2024],
        ["pack-count", 36],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-boxes"],
      tags: ["booster-box", "sealed", "surging-sparks"],
    },
    {
      itemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox as CatalogItemId,
      title: "Twilight Masquerade Elite Trainer Box",
      subtitle: "Sealed Elite Trainer Box",
      description:
        "A sealed Twilight Masquerade Elite Trainer Box with nine booster packs and accessories.",
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Twilight Masquerade"],
        ["language", "English"],
        ["release-year", 2024],
        ["pack-count", 9],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "elite-trainer-boxes"],
      tags: ["elite-trainer-box", "sealed", "twilight-masquerade"],
    },
  ];

  for (const item of items) {
    const streamId = `catalog.item-${item.itemId}`;

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "CreateItem",
      itemId: item.itemId,
      title: item.title,
      subtitle: item.subtitle,
      description: item.description,
    });

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "AssignBlueprintToItem",
      blueprintId: blueprints[item.blueprintKey],
    });

    for (const [fieldKey, value] of item.fieldValues) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "SetItemFieldValue",
        fieldId: fields[fieldKey],
        value,
      });
    }

    for (const categoryKey of item.categoryKeys) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AssignItemToCategory",
        categoryId: categories[categoryKey],
      });
    }

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "SetItemTags",
      tags: item.tags,
    });

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: requiredFieldIdsByBlueprint[item.blueprintKey],
    });

    console.log(`  Item "${item.title}" created and published`);
  }
}




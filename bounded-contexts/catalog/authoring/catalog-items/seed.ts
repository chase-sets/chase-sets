import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
import type { CatalogItemId } from "../../ids";
import { sendSeedCommand } from "../seed-support";
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

  const requiredFieldIds = [fields["card-number"], fields["card-name"]];

  type ItemDef = {
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
      title: "Charizard - Base Set 4/102",
      subtitle: "Holo Rare - Near Mint",
      description:
        "The iconic Base Set Charizard, one of the most sought-after Pokemon cards ever printed. Features the Fire Spin attack and stunning holographic artwork by Mitsuhiro Arita.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", "Charizard"],
        ["artist", "Mitsuhiro Arita"],
        ["year-printed", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "fire"],
      tags: ["charizard", "base-set", "holo", "vintage"],
    },
    {
      title: "Charizard - Base Set 4/102 PSA 10",
      subtitle: "Gem Mint - PSA Graded",
      description:
        "A PSA Gem Mint 10 graded Base Set Charizard. The highest grade achievable, representing perfect centering, corners, edges, and surface.",
      blueprintKey: "graded-pokemon-card",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", "Charizard"],
        ["artist", "Mitsuhiro Arita"],
        ["year-printed", 1999],
        ["cert-number", "10234567"],
        ["pop-count", 122],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "fire"],
      tags: ["charizard", "base-set", "psa-10", "graded", "vintage"],
    },
    {
      title: "Pikachu - Jungle 60/64",
      subtitle: "Common - Near Mint",
      description:
        "A charming Pikachu from the Jungle expansion set, featuring artwork by Kagemaru Himeno. A classic collectible from the early days of the Pokemon TCG.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "60/64"],
        ["card-name", "Pikachu"],
        ["artist", "Kagemaru Himeno"],
        ["year-printed", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "gen-1", "electric"],
      tags: ["pikachu", "jungle", "vintage"],
    },
    {
      title: "Lugia - Neo Genesis 9/111 BGS 9.5",
      subtitle: "Gem Mint - BGS Graded",
      description:
        "A BGS 9.5 Gem Mint graded Lugia from Neo Genesis. One of the most valuable Generation II era cards, featuring Hironobu Yoshida's legendary artwork.",
      blueprintKey: "graded-pokemon-card",
      fieldValues: [
        ["card-number", "9/111"],
        ["card-name", "Lugia"],
        ["artist", "Hironobu Yoshida"],
        ["year-printed", 2000],
        ["cert-number", "BGS87654321"],
        ["pop-count", 45],
      ],
      categoryKeys: ["pokemon-tcg", "gen-2", "psychic"],
      tags: ["lugia", "neo-genesis", "graded", "vintage"],
    },
    {
      title: "Pikachu - Prismatic Evolutions 025",
      subtitle: "Illustration Rare - Near Mint",
      description:
        "A stunning Illustration Rare Pikachu from the modern Prismatic Evolutions set, showcasing Ryuta Fuse's vibrant artwork in the latest Scarlet & Violet era.",
      blueprintKey: "raw-pokemon-card",
      fieldValues: [
        ["card-number", "025"],
        ["card-name", "Pikachu"],
        ["artist", "Ryuta Fuse"],
        ["year-printed", 2025],
      ],
      categoryKeys: ["pokemon-tcg", "gen-9", "electric"],
      tags: ["pikachu", "prismatic-evolutions", "modern"],
    },
  ];

  for (const item of items) {
    const itemId = createId("cat") as CatalogItemId;
    const streamId = `catalog.item-${itemId}`;

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "CreateItem",
      itemId,
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
      requiredFieldIds,
    });

    console.log(`  Item "${item.title}" created and published`);
  }
}




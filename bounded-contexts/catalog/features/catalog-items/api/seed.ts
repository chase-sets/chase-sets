import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { CatalogItemId, FieldId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { BlueprintIds } from "../../blueprints/api/seed";
import type { CategoryIds } from "../../categories/api/seed";
import type { FieldIds } from "../../fields/api/seed";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";

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
    ],
    "pokemon-sealed-product": [
      fields["set-name"],
      fields["pack-count"],
    ],
  };

  type ItemDef = {
    itemId: CatalogItemId;
    languageCode: string;
    title: LocalizedTextMap;
    subtitle: LocalizedTextMap;
    description: LocalizedTextMap;
    blueprintKey: string;
    fieldValues: [string, string | number | LocalizedTextMap][];
    categoryKeys: string[];
    tags: string[];
    externalProductReferences?: Array<{
      providerKey: string;
      externalKey: string;
      selectedOptions: Array<{ dimensionId: string; optionId: string }>;
    }>;
  };

  const items: ItemDef[] = [
    {
      itemId: catalogSeedIds.items.charizardBaseSet as CatalogItemId,
      languageCode: "en",
      title: l10n("Charizard"),
      subtitle: l10n("Base Set 4/102 Holo Rare"),
      description: l10n(
        "The iconic Base Set Charizard, seeded as a single Catalog Item whose sellable Products vary by Form, Condition, and Grade.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "4/102"],
        ["card-name", l10n("Charizard")],
        ["set-name", "Base Set"],
        ["rarity", "Holo Rare"],
        ["artist", "Mitsuhiro Arita"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "fire"],
      tags: ["base-set", "charizard", "holo", "vintage"],
      externalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "tcg_sku_1",
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
        },
      ],
    },
    {
      itemId: catalogSeedIds.items.pikachuJungle as CatalogItemId,
      languageCode: "en",
      title: l10n("Pikachu"),
      subtitle: l10n("Jungle 60/64 Common"),
      description: l10n(
        "A classic Jungle Pikachu seeded as one catalog item instead of separate raw and graded items.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "60/64"],
        ["card-name", l10n("Pikachu")],
        ["set-name", "Jungle"],
        ["rarity", "Common"],
        ["artist", "Kagemaru Himeno"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "electric"],
      tags: ["jungle", "pikachu", "vintage"],
      externalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "tcg_sku_pikachu_jungle_nm",
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
        },
      ],
    },
    {
      itemId: catalogSeedIds.items.japaneseCharizardBaseSet as CatalogItemId,
      languageCode: "ja",
      title: l10n("Charizard", { ja: "リザードン" }),
      subtitle: l10n("Japanese Base Set No. 006 Holo Rare", {
        ja: "ポケットモンスターカードゲーム 第1弾 No.006 キラ",
      }),
      description: l10n(
        "Japanese Base Set Charizard kept as its own catalog item so Japanese supply, offers, and pricing remain distinct.",
        {
          ja: "日本語版第1弾のリザードン。日本語版の在庫、オファー、価格を別の市場として扱うため独立したカタログアイテムです。",
        },
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "No.006"],
        ["card-name", l10n("Charizard", { ja: "リザードン" })],
        ["set-name", "Expansion Pack"],
        ["rarity", "Holo Rare"],
        ["artist", "Mitsuhiro Arita"],
        ["release-year", 1996],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "fire"],
      tags: ["base-set", "charizard", "holo", "japanese", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.lugiaNeoGenesis as CatalogItemId,
      languageCode: "en",
      title: l10n("Lugia"),
      subtitle: l10n("Neo Genesis 9/111 Holo Rare"),
      description: l10n(
        "A Neo Genesis Lugia single whose raw and graded variants resolve from the same catalog item.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "9/111"],
        ["card-name", l10n("Lugia")],
        ["set-name", "Neo Genesis"],
        ["rarity", "Holo Rare"],
        ["artist", "Hironobu Yoshida"],
        ["release-year", 2000],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-2", "psychic"],
      tags: ["lugia", "neo-genesis", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.mewtwoBlackStarPromo as CatalogItemId,
      languageCode: "en",
      title: l10n("Mewtwo"),
      subtitle: l10n("Black Star Promo 3"),
      description: l10n(
        "A Black Star Promo Mewtwo used by the marketplace seed as a listings-only market case.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "3"],
        ["card-name", l10n("Mewtwo")],
        ["set-name", "Wizards Black Star Promos"],
        ["rarity", "Promo"],
        ["artist", "Ken Sugimori"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "psychic"],
      tags: ["mewtwo", "promo", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.bulbasaurBaseSet as CatalogItemId,
      languageCode: "en",
      title: l10n("Bulbasaur"),
      subtitle: l10n("Base Set 44/102 Common"),
      description: l10n(
        "A catalog-only item used by the marketplace seed to keep a no-listings-and-no-offers case available.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "44/102"],
        ["card-name", l10n("Bulbasaur")],
        ["set-name", "Base Set"],
        ["rarity", "Common"],
        ["artist", "Mitsuhiro Arita"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "grass"],
      tags: ["base-set", "bulbasaur", "vintage"],
    },
    {
      itemId: catalogSeedIds.items.pikachuPrismaticEvolutions as CatalogItemId,
      languageCode: "en",
      title: l10n("Pikachu"),
      subtitle: l10n("Prismatic Evolutions 025 Illustration Rare"),
      description: l10n(
        "A modern Pikachu single from Prismatic Evolutions with Form-based Products instead of duplicated raw and graded Catalog Items.",
      ),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "025"],
        ["card-name", l10n("Pikachu")],
        ["set-name", "Prismatic Evolutions"],
        ["rarity", "Illustration Rare"],
        ["artist", "Ryuta Fuse"],
        ["release-year", 2025],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-9", "electric"],
      tags: ["modern", "pikachu", "prismatic-evolutions"],
    },
    {
      itemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack as CatalogItemId,
      languageCode: "en",
      title: l10n("Prismatic Evolutions Booster Pack"),
      subtitle: l10n("Sealed booster pack"),
      description: l10n(
        "A single sealed booster pack from the Prismatic Evolutions set.",
      ),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Prismatic Evolutions"],
        ["release-year", 2025],
        ["pack-count", 1],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-packs"],
      tags: ["booster-pack", "prismatic-evolutions", "sealed"],
    },
    {
      itemId: catalogSeedIds.items.surgingSparksBoosterBox as CatalogItemId,
      languageCode: "en",
      title: l10n("Surging Sparks Booster Box"),
      subtitle: l10n("Sealed booster box"),
      description: l10n(
        "A factory sealed Surging Sparks booster box containing 36 packs.",
      ),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Surging Sparks"],
        ["release-year", 2024],
        ["pack-count", 36],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-boxes"],
      tags: ["booster-box", "sealed", "surging-sparks"],
    },
    {
      itemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox as CatalogItemId,
      languageCode: "en",
      title: l10n("Twilight Masquerade Elite Trainer Box"),
      subtitle: l10n("Sealed Elite Trainer Box"),
      description: l10n(
        "A sealed Twilight Masquerade Elite Trainer Box with nine booster packs and accessories.",
      ),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["set-name", "Twilight Masquerade"],
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
      type: "CreateCatalogItem",
      itemId: item.itemId,
      languageCode: item.languageCode,
      title: item.title,
      subtitle: item.subtitle,
      description: item.description,
    });

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: blueprints[item.blueprintKey],
    });

    for (const [fieldKey, value] of item.fieldValues) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "SetCatalogItemFieldValue",
        fieldId: fields[fieldKey],
        value,
      });
    }

    for (const categoryKey of item.categoryKeys) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AssignCatalogItemToCategory",
        categoryId: categories[categoryKey],
      });
    }

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "SetCatalogItemTags",
      tags: item.tags,
    });

    for (const reference of item.externalProductReferences ?? []) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "LinkExternalProductReference",
        providerKey: reference.providerKey,
        externalKey: reference.externalKey,
        selectedOptions: reference.selectedOptions,
      });
    }

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: requiredFieldIdsByBlueprint[item.blueprintKey],
    });

    console.log(`  Item "${item.title.values.en}" created and published`);
  }
}

function l10n(en: string, values: Record<string, string> = {}): LocalizedTextMap {
  return {
    defaultLocale: "en",
    values: {
      en,
      ...values,
    },
  };
}

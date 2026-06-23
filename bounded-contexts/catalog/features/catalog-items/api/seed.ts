import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { CatalogItemId, FieldId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { CatalogItemImageFallback } from "../domain/domain";
import type { BlueprintIds } from "../../blueprints/api/seed";
import type { CategoryIds } from "../../categories/api/seed";
import type { FieldIds } from "../../fields/api/seed";
import type { CatalogReferenceIds } from "../../reference-data/api/seed";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";

export async function seedCatalogItems(
  services: CatalogServices,
  blueprints: BlueprintIds,
  fields: FieldIds,
  categories: CategoryIds,
  references: CatalogReferenceIds,
): Promise<void> {
  console.log("Seeding catalog items...");

  const requiredFieldIdsByBlueprint: Record<string, readonly FieldId[]> = {
    "pokemon-card-single": [fields["card-number"], fields["card-name"], fields.expansion, fields.rarity],
    "pokemon-sealed-product": [fields.expansion, fields["pack-count"]],
    "one-piece-card-print": [fields["card-number"], fields["card-name"], fields.set],
    "one-piece-sealed-product": [fields.set, fields["pack-count"]],
  };

  type ItemDef = {
    itemId: CatalogItemId;
    languageCode: string;
    title: LocalizedTextMap;
    subtitle: LocalizedTextMap;
    description: LocalizedTextMap;
    blueprintKey: string;
    fieldValues: [string, string | number | LocalizedTextMap | { referenceId: string }][];
    categoryKeys: string[];
    tags: string[];
    externalCatalogItemReferences?: Array<{
      providerKey: string;
      externalKey: string;
    }>;
    externalProductReferences?: Array<{
      providerKey: string;
      externalKey: string;
      selectedOptions: Array<{ dimensionId: string; optionId: string }>;
    }>;
    imageFallback?: CatalogItemImageFallback;
  };

  const expansionReference = (key: keyof CatalogReferenceIds["expansions"]) => ({
    referenceId: references.expansions[key],
  });
  const setReference = (key: keyof CatalogReferenceIds["onePiece"]["sets"]) => ({
    referenceId: references.onePiece.sets[key],
  });

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
        ["expansion", expansionReference("base-set")],
        ["rarity", "Holo Rare"],
        ["card-illustrator", "Mitsuhiro Arita"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "fire"],
      tags: ["base-set", "charizard", "holo", "vintage"],
      imageFallback: pokemonEnglishCardBack(),
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
        ["expansion", expansionReference("jungle")],
        ["rarity", "Common"],
        ["card-illustrator", "Kagemaru Himeno"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "electric"],
      tags: ["jungle", "pikachu", "vintage"],
      imageFallback: pokemonEnglishCardBack(),
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
        ["expansion", expansionReference("base-set")],
        ["rarity", "Holo Rare"],
        ["card-illustrator", "Mitsuhiro Arita"],
        ["release-year", 1996],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "fire"],
      tags: ["base-set", "charizard", "holo", "japanese", "vintage"],
      imageFallback: pokemonJapaneseCardBack(),
    },
    {
      itemId: catalogSeedIds.items.lugiaNeoGenesis as CatalogItemId,
      languageCode: "en",
      title: l10n("Lugia"),
      subtitle: l10n("Neo Genesis 9/111 Holo Rare"),
      description: l10n("A Neo Genesis Lugia single whose raw and graded variants resolve from the same catalog item."),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "9/111"],
        ["card-name", l10n("Lugia")],
        ["expansion", expansionReference("neo-genesis")],
        ["rarity", "Holo Rare"],
        ["card-illustrator", "Hironobu Yoshida"],
        ["release-year", 2000],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-2", "psychic"],
      tags: ["lugia", "neo-genesis", "vintage"],
      imageFallback: pokemonEnglishCardBack(),
    },
    {
      itemId: catalogSeedIds.items.mewtwoBlackStarPromo as CatalogItemId,
      languageCode: "en",
      title: l10n("Mewtwo"),
      subtitle: l10n("Black Star Promo 3"),
      description: l10n("A Black Star Promo Mewtwo used by the marketplace seed as a listings-only market case."),
      blueprintKey: "pokemon-card-single",
      fieldValues: [
        ["card-number", "3"],
        ["card-name", l10n("Mewtwo")],
        ["expansion", expansionReference("wizards-black-star-promos")],
        ["rarity", "Promo"],
        ["card-illustrator", "Ken Sugimori"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "psychic"],
      tags: ["mewtwo", "promo", "vintage"],
      imageFallback: pokemonEnglishCardBack(),
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
        ["expansion", expansionReference("base-set")],
        ["rarity", "Common"],
        ["card-illustrator", "Mitsuhiro Arita"],
        ["release-year", 1999],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-1", "grass"],
      tags: ["base-set", "bulbasaur", "vintage"],
      imageFallback: pokemonEnglishCardBack(),
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
        ["expansion", expansionReference("prismatic-evolutions")],
        ["rarity", "Illustration Rare"],
        ["card-illustrator", "Ryuta Fuse"],
        ["release-year", 2025],
      ],
      categoryKeys: ["pokemon-tcg", "singles", "gen-9", "electric"],
      tags: ["modern", "pikachu", "prismatic-evolutions"],
      imageFallback: pokemonEnglishCardBack(),
    },
    {
      itemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack as CatalogItemId,
      languageCode: "en",
      title: l10n("Prismatic Evolutions Booster Pack"),
      subtitle: l10n("Sealed booster pack"),
      description: l10n("A single sealed booster pack from the Prismatic Evolutions set."),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["expansion", expansionReference("prismatic-evolutions")],
        ["release-year", 2025],
        ["pack-count", 1],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-packs"],
      tags: ["booster-pack", "prismatic-evolutions", "sealed"],
      imageFallback: pokemonSealedFallback(),
    },
    {
      itemId: catalogSeedIds.items.surgingSparksBoosterBox as CatalogItemId,
      languageCode: "en",
      title: l10n("Surging Sparks Booster Box"),
      subtitle: l10n("Sealed booster box"),
      description: l10n("A factory sealed Surging Sparks booster box containing 36 packs."),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["expansion", expansionReference("surging-sparks")],
        ["release-year", 2024],
        ["pack-count", 36],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "booster-boxes"],
      tags: ["booster-box", "sealed", "surging-sparks"],
      imageFallback: pokemonSealedFallback(),
    },
    {
      itemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox as CatalogItemId,
      languageCode: "en",
      title: l10n("Twilight Masquerade Elite Trainer Box"),
      subtitle: l10n("Sealed Elite Trainer Box"),
      description: l10n("A sealed Twilight Masquerade Elite Trainer Box with nine booster packs and accessories."),
      blueprintKey: "pokemon-sealed-product",
      fieldValues: [
        ["expansion", expansionReference("twilight-masquerade")],
        ["release-year", 2024],
        ["pack-count", 9],
      ],
      categoryKeys: ["pokemon-tcg", "sealed-products", "elite-trainer-boxes"],
      tags: ["elite-trainer-box", "sealed", "twilight-masquerade"],
      imageFallback: pokemonSealedFallback(),
    },
    {
      itemId: catalogSeedIds.items.onePieceLuffyRomanceDawn as CatalogItemId,
      languageCode: "en",
      title: l10n("Monkey.D.Luffy"),
      subtitle: l10n("Romance Dawn OP01-001 Leader"),
      description: l10n(
        "A representative Romance Dawn One Piece card print whose raw and graded Products resolve from one Catalog Item.",
      ),
      blueprintKey: "one-piece-card-print",
      fieldValues: [
        ["card-number", "OP01-001"],
        ["card-name", l10n("Monkey.D.Luffy")],
        ["set", setReference("romance-dawn")],
        ["rarity", "Leader"],
        ["card-variant", "Standard Art"],
        ["release-year", 2022],
      ],
      categoryKeys: ["one-piece-card-game", "one-piece-card-prints"],
      tags: ["one-piece", "romance-dawn", "leader", "luffy"],
      imageFallback: onePieceCardBack(),
      externalCatalogItemReferences: [
        {
          providerKey: "scrydex",
          externalKey: "card:op01-001",
        },
        {
          providerKey: "tcgplayer",
          externalKey: "product:987650",
        },
      ],
      externalProductReferences: [
        {
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
        },
      ],
    },
    {
      itemId: catalogSeedIds.items.onePieceRomanceDawnBoosterBox as CatalogItemId,
      languageCode: "en",
      title: l10n("Romance Dawn Booster Box"),
      subtitle: l10n("Sealed booster box"),
      description: l10n("A factory sealed One Piece Romance Dawn booster box."),
      blueprintKey: "one-piece-sealed-product",
      fieldValues: [
        ["set", setReference("romance-dawn")],
        ["release-year", 2022],
        ["pack-count", 24],
      ],
      categoryKeys: ["one-piece-card-game", "one-piece-sealed-products", "one-piece-booster-boxes"],
      tags: ["one-piece", "romance-dawn", "booster-box", "sealed"],
      imageFallback: onePieceSealedFallback(),
      externalCatalogItemReferences: [
        {
          providerKey: "scrydex",
          externalKey: "sealed-product:op01-booster-box",
        },
        {
          providerKey: "tcgplayer",
          externalKey: "product:987660",
        },
      ],
      externalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:900987660",
          selectedOptions: [],
        },
      ],
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

    if (item.imageFallback) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "SetCatalogItemImageFallback",
        imageFallback: item.imageFallback,
      });
    }

    for (const reference of item.externalCatalogItemReferences ?? []) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "LinkExternalCatalogItemReference",
        providerKey: reference.providerKey,
        externalKey: reference.externalKey,
      });
    }

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

function pokemonEnglishCardBack(): CatalogItemImageFallback {
  return imageFallback("/fake-cdn/assets/pokemon_tcg_back.png", "Pokemon TCG English card back", "permanent");
}

function pokemonJapaneseCardBack(): CatalogItemImageFallback {
  return imageFallback("/fake-cdn/assets/pokemon-card-back.png", "Pokemon TCG Japanese card back", "permanent");
}

function pokemonSealedFallback(): CatalogItemImageFallback {
  return imageFallback(
    "/fake-cdn/assets/pokemon-card-back.png",
    "Pokemon sealed product loading image",
    "loading-only",
  );
}

function onePieceCardBack(): CatalogItemImageFallback {
  return imageFallback("/fake-cdn/assets/one-piece-card-back.png", "One Piece Card Game card back", "permanent");
}

function onePieceSealedFallback(): CatalogItemImageFallback {
  return imageFallback(
    "/fake-cdn/assets/one-piece-card-back.png",
    "One Piece sealed product loading image",
    "loading-only",
  );
}

function imageFallback(url: string, alt: string, usage: CatalogItemImageFallback["usage"]): CatalogItemImageFallback {
  return {
    url,
    alt,
    usage,
    variants: {
      card: { oneX: url, twoX: url },
      detail: { oneX: url, twoX: url },
      thumbnail: { oneX: url, twoX: url },
    },
  };
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

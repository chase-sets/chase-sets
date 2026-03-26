import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
import type { ChoiceId, DimensionId } from "../../ids";
import { sendSeedCommand } from "../seed-support";

type DimensionChoiceDef = {
  code: string;
  label: string;
  numericValue?: number;
};

type DimensionDef = {
  key: string;
  name: string;
  description: string;
  choices: DimensionChoiceDef[];
};

const dimensionDefs: DimensionDef[] = [
  {
    key: "condition",
    name: "Condition",
    description: "Physical condition of a raw (ungraded) card",
    choices: [
      { code: "mint", label: "Mint" },
      { code: "near-mint", label: "Near Mint" },
      { code: "lightly-played", label: "Lightly Played" },
      { code: "moderately-played", label: "Moderately Played" },
      { code: "heavily-played", label: "Heavily Played" },
      { code: "damaged", label: "Damaged" },
    ],
  },
  {
    key: "grading-company",
    name: "Grading Company",
    description:
      "Professional grading service that authenticated and graded the card",
    choices: [
      { code: "psa", label: "PSA" },
      { code: "bgs", label: "BGS/Beckett" },
      { code: "cgc", label: "CGC" },
      { code: "sgc", label: "SGC" },
      { code: "ace", label: "ACE" },
      { code: "tag", label: "TAG" },
    ],
  },
  {
    key: "grade",
    name: "Grade",
    description: "Numeric grade assigned by a professional grading company",
    choices: [
      { code: "pristine-10", label: "Pristine 10", numericValue: 10.5 },
      { code: "gem-mint-10", label: "Gem Mint 10", numericValue: 10 },
      { code: "mint-9.5", label: "Mint 9.5", numericValue: 9.5 },
      { code: "mint-9", label: "Mint 9", numericValue: 9 },
      { code: "nm-mt-8.5", label: "NM-MT 8.5", numericValue: 8.5 },
      { code: "nm-mt-8", label: "NM-MT 8", numericValue: 8 },
      { code: "nm-7", label: "NM 7", numericValue: 7 },
      { code: "ex-6", label: "EX 6", numericValue: 6 },
      { code: "ex-5", label: "EX 5", numericValue: 5 },
      { code: "vg-4", label: "VG 4", numericValue: 4 },
      { code: "good-3", label: "Good 3", numericValue: 3 },
      { code: "good-2", label: "Good 2", numericValue: 2 },
      { code: "poor-1", label: "Poor 1", numericValue: 1 },
    ],
  },
  {
    key: "pokemon-set",
    name: "Pokemon Set",
    description: "The expansion set the card belongs to",
    choices: [
      { code: "base-set", label: "Base Set" },
      { code: "jungle", label: "Jungle" },
      { code: "fossil", label: "Fossil" },
      { code: "team-rocket", label: "Team Rocket" },
      { code: "gym-heroes", label: "Gym Heroes" },
      { code: "gym-challenge", label: "Gym Challenge" },
      { code: "neo-genesis", label: "Neo Genesis" },
      { code: "neo-discovery", label: "Neo Discovery" },
      { code: "neo-revelation", label: "Neo Revelation" },
      { code: "neo-destiny", label: "Neo Destiny" },
      { code: "legendary-collection", label: "Legendary Collection" },
      { code: "expedition", label: "Expedition" },
      { code: "aquapolis", label: "Aquapolis" },
      { code: "skyridge", label: "Skyridge" },
      { code: "scarlet-violet", label: "Scarlet & Violet" },
      { code: "paldea-evolved", label: "Paldea Evolved" },
      { code: "obsidian-flames", label: "Obsidian Flames" },
      { code: "pokemon-151", label: "151" },
      { code: "paradox-rift", label: "Paradox Rift" },
      { code: "temporal-forces", label: "Temporal Forces" },
      { code: "twilight-masquerade", label: "Twilight Masquerade" },
      { code: "shrouded-fable", label: "Shrouded Fable" },
      { code: "stellar-crown", label: "Stellar Crown" },
      { code: "surging-sparks", label: "Surging Sparks" },
      { code: "prismatic-evolutions", label: "Prismatic Evolutions" },
    ],
  },
  {
    key: "rarity",
    name: "Rarity",
    description: "Card rarity classification",
    choices: [
      { code: "common", label: "Common" },
      { code: "uncommon", label: "Uncommon" },
      { code: "rare", label: "Rare" },
      { code: "holo-rare", label: "Holo Rare" },
      { code: "reverse-holo", label: "Reverse Holo" },
      { code: "ultra-rare", label: "Ultra Rare" },
      { code: "secret-rare", label: "Secret Rare" },
      { code: "illustration-rare", label: "Illustration Rare" },
      { code: "special-illustration-rare", label: "Special Illustration Rare" },
      { code: "hyper-rare", label: "Hyper Rare" },
      { code: "gold-star", label: "Gold Star" },
      { code: "first-edition", label: "1st Edition" },
    ],
  },
  {
    key: "language",
    name: "Language",
    description: "The language the card is printed in",
    choices: [
      { code: "en", label: "English" },
      { code: "ja", label: "Japanese" },
      { code: "ko", label: "Korean" },
      { code: "zh", label: "Chinese" },
      { code: "fr", label: "French" },
      { code: "de", label: "German" },
      { code: "es", label: "Spanish" },
      { code: "it", label: "Italian" },
      { code: "pt", label: "Portuguese" },
    ],
  },
];

export type DimensionIds = Record<
  string,
  { dimensionId: DimensionId; choiceIds: Record<string, ChoiceId> }
>;

export async function seedDimensions(
  services: CatalogServices,
): Promise<DimensionIds> {
  console.log("Seeding dimensions...");
  const result: DimensionIds = {};

  for (const def of dimensionDefs) {
    const dimensionId = createId("dim") as DimensionId;
    const streamId = `catalog.dimension-${dimensionId}`;
    const choiceIds: Record<string, ChoiceId> = {};

    await sendSeedCommand(services.dimensionHandler, streamId, {
      type: "CreateDimension",
      dimensionId,
      key: def.key,
      name: def.name,
      description: def.description,
    });

    for (const choice of def.choices) {
      const choiceId = createId("chc") as ChoiceId;
      choiceIds[choice.code] = choiceId;

      await sendSeedCommand(services.dimensionHandler, streamId, {
        type: "AddChoice",
        choiceId,
        code: choice.code,
        labels: [{ locale: "en", value: choice.label }],
        numericValue: choice.numericValue ?? null,
      });
    }

    await sendSeedCommand(services.dimensionHandler, streamId, {
      type: "ActivateDimension",
    });

    result[def.key] = { dimensionId, choiceIds };
    console.log(
      `  Dimension "${def.name}" created with ${def.choices.length} choices`,
    );
  }

  return result;
}




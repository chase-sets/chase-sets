import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { CatalogValue } from "../../../support/runtime-support/common";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { ReferenceRelationship } from "../domain/domain";

type ReferenceTypeDef = Readonly<{
  referenceTypeId: ReferenceTypeId;
  key: string;
  name: string;
  description: string;
  attributeKeys: readonly string[];
}>;

type ReferenceRecordDef = Readonly<{
  referenceRecordId: ReferenceRecordId;
  typeKey: string;
  key: string;
  name: string;
  description: string;
  attributes?: Readonly<Record<string, CatalogValue>>;
  relationships?: readonly ReferenceRelationship[];
}>;

export type PokemonReferenceIds = Readonly<{
  expansions: Readonly<Record<string, ReferenceRecordId>>;
}>;

const referenceTypes: readonly ReferenceTypeDef[] = [
  {
    referenceTypeId: catalogSeedIds.referenceTypes.manufacturer,
    key: "manufacturer",
    name: "Manufacturer",
    description: "A company responsible for publishing or manufacturing catalog products.",
    attributeKeys: ["homepage-url"],
  },
  {
    referenceTypeId: catalogSeedIds.referenceTypes.productLine,
    key: "product-line",
    name: "Product Line",
    description: "A branded collectible product line.",
    attributeKeys: ["official-name", "short-name"],
  },
  {
    referenceTypeId: catalogSeedIds.referenceTypes.series,
    key: "series",
    name: "Series",
    description: "An official Pokemon TCG series that groups expansions.",
    attributeKeys: ["tcgdex-series-id"],
  },
  {
    referenceTypeId: catalogSeedIds.referenceTypes.expansion,
    key: "expansion",
    name: "Expansion",
    description: "An official Pokemon TCG card expansion.",
    attributeKeys: [
      "abbreviation",
      "card-count",
      "parallel-set-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
  },
];

const manufacturerId =
  catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational;
const productLineId =
  catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame;
const seriesIds = catalogSeedIds.referenceRecords.series;
const expansionIds = catalogSeedIds.referenceRecords.expansions;

const referenceRecords: readonly ReferenceRecordDef[] = [
  {
    referenceRecordId: manufacturerId,
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    description: "Publisher of the English Pokemon Trading Card Game.",
    attributes: {
      "homepage-url": "https://www.pokemon.com/us",
    },
  },
  {
    referenceRecordId: productLineId,
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    description: "The Pokemon Trading Card Game product line.",
    attributes: {
      "official-name": "Pokemon Trading Card Game",
      "short-name": "Pokemon TCG",
    },
    relationships: [{ relationshipType: "published-by", referenceId: manufacturerId }],
  },
  {
    referenceRecordId: seriesIds.base,
    typeKey: "series",
    key: "base",
    name: "Base",
    description: "The original English Pokemon TCG series in TCGdex source data.",
    attributes: { "tcgdex-series-id": "base" },
    relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
  },
  {
    referenceRecordId: seriesIds.neo,
    typeKey: "series",
    key: "neo",
    name: "Neo",
    description: "The Neo English Pokemon TCG series.",
    attributes: { "tcgdex-series-id": "neo" },
    relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
  },
  {
    referenceRecordId: seriesIds.scarletViolet,
    typeKey: "series",
    key: "scarlet-violet",
    name: "Scarlet & Violet",
    description: "The Scarlet & Violet Pokemon TCG series.",
    attributes: { "tcgdex-series-id": "sv" },
    relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
  },
  {
    referenceRecordId: seriesIds.wizardBlackStarPromos,
    typeKey: "series",
    key: "wizards-black-star-promos",
    name: "Wizards Black Star Promos",
    description: "The English Wizards Black Star promotional card series.",
    relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
  },
  expansion("base-set", "Base Set", expansionIds.baseSet, seriesIds.base, {
    abbreviation: "BS",
    "card-count": 102,
    "release-date": "1999-01-09",
    "tcgdex-set-id": "base1",
  }),
  expansion("jungle", "Jungle", expansionIds.jungle, seriesIds.base, {
    abbreviation: "JU",
    "card-count": 64,
    "release-date": "1999-06-16",
    "tcgdex-set-id": "base2",
  }),
  expansion("neo-genesis", "Neo Genesis", expansionIds.neoGenesis, seriesIds.neo, {
    abbreviation: "N1",
    "card-count": 111,
    "release-date": "2000-12-16",
    "tcgdex-set-id": "neo1",
  }),
  expansion(
    "wizards-black-star-promos",
    "Wizards Black Star Promos",
    expansionIds.wizardsBlackStarPromos,
    seriesIds.wizardBlackStarPromos,
    {
      abbreviation: "PR",
      "tcgdex-set-id": "basep",
    },
  ),
  expansion(
    "prismatic-evolutions",
    "Prismatic Evolutions",
    expansionIds.prismaticEvolutions,
    seriesIds.scarletViolet,
    {
      abbreviation: "PRE",
      "release-date": "2025-01-17",
      "tcgdex-set-id": "sv8.5",
    },
  ),
  expansion(
    "surging-sparks",
    "Surging Sparks",
    expansionIds.surgingSparks,
    seriesIds.scarletViolet,
    {
      abbreviation: "SSP",
      "release-date": "2024-11-08",
      "tcgdex-set-id": "sv8",
    },
  ),
  expansion(
    "twilight-masquerade",
    "Twilight Masquerade",
    expansionIds.twilightMasquerade,
    seriesIds.scarletViolet,
    {
      abbreviation: "TWM",
      "release-date": "2024-05-24",
      "tcgdex-set-id": "sv6",
    },
  ),
];

export async function seedReferenceData(
  services: CatalogServices,
): Promise<PokemonReferenceIds> {
  console.log("Seeding reference data...");

  for (const def of referenceTypes) {
    const streamId = `catalog.reference-type-${def.referenceTypeId}`;

    await sendSeedCommand(services.referenceData.referenceTypeCommandHandler, streamId, {
      type: "CreateReferenceType",
      referenceTypeId: def.referenceTypeId,
      key: def.key,
      name: localizedTextMapFromEnglish(def.name),
      description: localizedTextMapFromEnglish(def.description),
      attributeKeys: def.attributeKeys,
    });

    await sendSeedCommand(services.referenceData.referenceTypeCommandHandler, streamId, {
      type: "PublishReferenceType",
    });

    console.log(`  Reference Type "${def.name}" created`);
  }

  for (const def of referenceRecords) {
    const streamId = `catalog.reference-record-${def.referenceRecordId}`;

    await sendSeedCommand(services.referenceData.referenceRecordCommandHandler, streamId, {
      type: "CreateReferenceRecord",
      referenceRecordId: def.referenceRecordId,
      typeKey: def.typeKey,
      key: def.key,
      name: localizedTextMapFromEnglish(def.name),
      description: localizedTextMapFromEnglish(def.description),
      attributes: def.attributes ?? {},
      relationships: def.relationships ?? [],
    });

    await sendSeedCommand(services.referenceData.referenceRecordCommandHandler, streamId, {
      type: "PublishReferenceRecord",
    });

    console.log(`  Reference Record "${def.name}" created`);
  }

  return {
    expansions: {
      "base-set": expansionIds.baseSet,
      jungle: expansionIds.jungle,
      "neo-genesis": expansionIds.neoGenesis,
      "wizards-black-star-promos": expansionIds.wizardsBlackStarPromos,
      "prismatic-evolutions": expansionIds.prismaticEvolutions,
      "surging-sparks": expansionIds.surgingSparks,
      "twilight-masquerade": expansionIds.twilightMasquerade,
    },
  };
}

function expansion(
  key: string,
  name: string,
  referenceRecordId: ReferenceRecordId,
  seriesId: ReferenceRecordId,
  attributes: Readonly<Record<string, CatalogValue>>,
): ReferenceRecordDef {
  return {
    referenceRecordId,
    typeKey: "expansion",
    key,
    name,
    description: `${name} Pokemon TCG expansion.`,
    attributes,
    relationships: [{ relationshipType: "part-of", referenceId: seriesId }],
  };
}

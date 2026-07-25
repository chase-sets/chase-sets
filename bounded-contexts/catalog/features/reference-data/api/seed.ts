import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { LocalizedTextMap } from "@chase-sets/localization";
import { retryLocalProjectionBlockedStream } from "@chase-sets/bounded-context-runtime";
import type { CatalogValue } from "../../../support/runtime-support/common";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { loadSeedAggregateState, loadSeedStreamEvents } from "../../../support/seed-support/aggregate-state";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import {
  evolveReferenceRecord,
  evolveReferenceType,
  initialReferenceRecordState,
  initialReferenceTypeState,
  type ReferenceRecordEvent,
  type ReferenceRelationship,
  type ReferenceTypeEvent,
} from "../domain/domain";
import { buildCatalogAliasCandidate } from "../../alias-equivalence/domain/alias";
import {
  catalogAliasStreamId,
  evolveCatalogAlias,
  initialCatalogAliasState,
  type CatalogAliasEvent,
} from "../../alias-equivalence/domain/domain";

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

export type MagicReferenceIds = Readonly<{
  sets: Readonly<Record<string, ReferenceRecordId>>;
}>;

export type OnePieceReferenceIds = Readonly<{
  sets: Readonly<Record<string, ReferenceRecordId>>;
}>;

export type LorcanaReferenceIds = Readonly<{
  sets: Readonly<Record<string, ReferenceRecordId>>;
}>;

export type CatalogReferenceIds = PokemonReferenceIds &
  Readonly<{
    magic: MagicReferenceIds;
    onePiece: OnePieceReferenceIds;
    lorcana: LorcanaReferenceIds;
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
    description: "An official product-line series that groups expansions or sets.",
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
      "printed-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
  },
  {
    referenceTypeId: catalogSeedIds.referenceTypes.set,
    key: "set",
    name: "Set",
    description: "An official card set for product lines that use set terminology.",
    attributeKeys: [
      "set-code",
      "printed-card-count",
      "release-date",
      "mtgjson-set-code",
      "scryfall-set-code",
      "scrydex-set-id",
      "chapter-number",
      "set-kind",
      "lorcanajson-set-code",
      "lorcanajson-set-name",
      "lorcast-set-code",
      "lorcast-set-name",
      "tcgplayer-set-name",
    ],
  },
];

const manufacturerId = catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational;
const magicManufacturerId = catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast;
const onePieceManufacturerId = catalogSeedIds.referenceRecords.manufacturers.bandai;
const lorcanaManufacturerId = catalogSeedIds.referenceRecords.manufacturers.ravensburger;
const productLineId = catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame;
const magicProductLineId = catalogSeedIds.referenceRecords.productLines.magicTheGathering;
const onePieceProductLineId = catalogSeedIds.referenceRecords.productLines.onePieceCardGame;
const lorcanaProductLineId = catalogSeedIds.referenceRecords.productLines.disneyLorcana;
const seriesIds = catalogSeedIds.referenceRecords.series;
const expansionIds = catalogSeedIds.referenceRecords.expansions;
const setIds = catalogSeedIds.referenceRecords.sets;

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
    referenceRecordId: magicManufacturerId,
    typeKey: "manufacturer",
    key: "wizards-of-the-coast",
    name: "Wizards of the Coast",
    description: "Publisher of Magic: The Gathering.",
    attributes: {
      "homepage-url": "https://magic.wizards.com",
    },
  },
  {
    referenceRecordId: magicProductLineId,
    typeKey: "product-line",
    key: "magic-the-gathering",
    name: "Magic: The Gathering",
    description: "The Magic: The Gathering trading card game product line.",
    attributes: {
      "official-name": "Magic: The Gathering",
      "short-name": "MTG",
    },
    relationships: [{ relationshipType: "published-by", referenceId: magicManufacturerId }],
  },
  {
    referenceRecordId: onePieceManufacturerId,
    typeKey: "manufacturer",
    key: "bandai",
    name: "Bandai",
    description: "Publisher and manufacturer of the One Piece Card Game.",
    attributes: {
      "homepage-url": "https://www.bandai.com",
    },
  },
  {
    referenceRecordId: onePieceProductLineId,
    typeKey: "product-line",
    key: "one-piece-card-game",
    name: "One Piece Card Game",
    description: "The One Piece Card Game product line.",
    attributes: {
      "official-name": "One Piece Card Game",
      "short-name": "One Piece",
    },
    relationships: [{ relationshipType: "published-by", referenceId: onePieceManufacturerId }],
  },
  {
    referenceRecordId: lorcanaManufacturerId,
    typeKey: "manufacturer",
    key: "ravensburger",
    name: "Ravensburger",
    description: "Publisher of the Disney Lorcana trading card game.",
    attributes: {
      "homepage-url": "https://www.ravensburger.us",
    },
  },
  {
    referenceRecordId: lorcanaProductLineId,
    typeKey: "product-line",
    key: "disney-lorcana",
    name: "Disney Lorcana",
    description: "The Disney Lorcana trading card game product line.",
    attributes: {
      "official-name": "Disney Lorcana",
      "short-name": "Lorcana",
    },
    relationships: [{ relationshipType: "published-by", referenceId: lorcanaManufacturerId }],
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
  expansion("prismatic-evolutions", "Prismatic Evolutions", expansionIds.prismaticEvolutions, seriesIds.scarletViolet, {
    abbreviation: "PRE",
    "release-date": "2025-01-17",
    "tcgdex-set-id": "sv8.5",
  }),
  expansion("surging-sparks", "Surging Sparks", expansionIds.surgingSparks, seriesIds.scarletViolet, {
    abbreviation: "SSP",
    "release-date": "2024-11-08",
    "tcgdex-set-id": "sv8",
  }),
  expansion("twilight-masquerade", "Twilight Masquerade", expansionIds.twilightMasquerade, seriesIds.scarletViolet, {
    abbreviation: "TWM",
    "release-date": "2024-05-24",
    "tcgdex-set-id": "sv6",
  }),
  magicSet("time-spiral", "Time Spiral", setIds.timeSpiral, {
    "set-code": "TSP",
    "printed-card-count": 301,
    "release-date": "2006-10-06",
    "mtgjson-set-code": "TSP",
    "scryfall-set-code": "tsp",
    "tcgplayer-set-name": "Time Spiral",
  }),
  onePieceSet("romance-dawn", "Romance Dawn", setIds.romanceDawn, {
    "set-code": "OP-01",
    "printed-card-count": 121,
    "release-date": "2022-12-02",
    "scrydex-set-id": "op-01",
    "tcgplayer-set-name": "Romance Dawn",
  }),
  lorcanaSet("the-first-chapter", "The First Chapter", setIds.lorcanaTheFirstChapter, {
    "set-code": "1",
    "chapter-number": 1,
    "set-kind": "chapter",
    "printed-card-count": 204,
    "release-date": "2023-08-18",
    "lorcanajson-set-code": "1",
    "lorcanajson-set-name": "The First Chapter",
    "lorcast-set-code": "1",
    "lorcast-set-name": "The First Chapter",
    "tcgplayer-set-name": "The First Chapter",
  }),
  lorcanaSet("d23-collection", "D23 Collection", setIds.lorcanaD23Collection, {
    "set-code": "D23",
    "set-kind": "promo-special",
    "printed-card-count": 9,
    "release-date": "2024-08-09",
    "lorcast-set-code": "D23",
    "lorcast-set-name": "D23 Collection",
    "tcgplayer-set-name": "D23 Promos",
  }),
];

export const referenceDataSeedRequirements = [
  ...referenceTypes.map((def) => ({
    aggregateName: "Reference Type" as const,
    id: def.referenceTypeId,
    key: def.key,
    streamId: `catalog.reference-type-${def.referenceTypeId}`,
    typeKey: null,
  })),
  ...referenceRecords.map((def) => ({
    aggregateName: "Reference Record" as const,
    id: def.referenceRecordId,
    key: def.key,
    streamId: `catalog.reference-record-${def.referenceRecordId}`,
    typeKey: def.typeKey,
  })),
] as const;

const magicReferenceTypeKeys = new Set(["manufacturer", "product-line", "set"]);
const magicReferenceRecordIds = new Set<ReferenceRecordId>([
  magicManufacturerId,
  magicProductLineId,
  setIds.timeSpiral,
]);
const onePieceReferenceTypeKeys = new Set(["manufacturer", "product-line", "set"]);
const onePieceReferenceRecordIds = new Set<ReferenceRecordId>([
  onePieceManufacturerId,
  onePieceProductLineId,
  setIds.romanceDawn,
]);
const lorcanaReferenceTypeKeys = new Set(["manufacturer", "product-line", "set"]);
const lorcanaReferenceRecordIds = new Set<ReferenceRecordId>([
  lorcanaManufacturerId,
  lorcanaProductLineId,
  setIds.lorcanaTheFirstChapter,
  setIds.lorcanaD23Collection,
]);

export async function seedReferenceData(services: CatalogServices): Promise<CatalogReferenceIds> {
  console.log("Reconciling reference data...");

  for (const def of referenceTypes) {
    await reconcileReferenceType(services, def);
  }

  for (const def of referenceRecords) {
    await reconcileReferenceRecord(services, def);
  }

  await seedOnePieceReferenceAliases(services);
  await seedLorcanaReferenceAliases(services);

  return staticReferenceIds();
}

export async function seedMagicReferenceData(services: CatalogServices): Promise<MagicReferenceIds> {
  console.log("Reconciling Magic reference data...");

  for (const def of referenceTypes.filter((candidate) => magicReferenceTypeKeys.has(candidate.key))) {
    await reconcileReferenceType(services, def);
  }

  for (const def of referenceRecords.filter((candidate) => magicReferenceRecordIds.has(candidate.referenceRecordId))) {
    await reconcileReferenceRecord(services, def);
  }

  return staticReferenceIds().magic;
}

export async function seedOnePieceReferenceData(services: CatalogServices): Promise<OnePieceReferenceIds> {
  console.log("Reconciling One Piece reference data...");

  for (const def of referenceTypes.filter((candidate) => onePieceReferenceTypeKeys.has(candidate.key))) {
    await reconcileReferenceType(services, def);
  }

  for (const def of referenceRecords.filter((candidate) =>
    onePieceReferenceRecordIds.has(candidate.referenceRecordId),
  )) {
    await reconcileReferenceRecord(services, def);
  }

  await seedOnePieceReferenceAliases(services);

  return staticReferenceIds().onePiece;
}

export async function seedLorcanaReferenceData(services: CatalogServices): Promise<LorcanaReferenceIds> {
  console.log("Reconciling Lorcana reference data...");

  for (const def of referenceTypes.filter((candidate) => lorcanaReferenceTypeKeys.has(candidate.key))) {
    await reconcileReferenceType(services, def);
  }

  for (const def of referenceRecords.filter((candidate) =>
    lorcanaReferenceRecordIds.has(candidate.referenceRecordId),
  )) {
    await reconcileReferenceRecord(services, def);
  }

  await seedLorcanaReferenceAliases(services);

  return staticReferenceIds().lorcana;
}

async function createReferenceType(services: CatalogServices, def: ReferenceTypeDef): Promise<void> {
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

async function createReferenceRecord(services: CatalogServices, def: ReferenceRecordDef): Promise<void> {
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

function staticReferenceIds(): CatalogReferenceIds {
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
    magic: {
      sets: {
        "time-spiral": setIds.timeSpiral,
      },
    },
    onePiece: {
      sets: {
        "romance-dawn": setIds.romanceDawn,
      },
    },
    lorcana: {
      sets: {
        "the-first-chapter": setIds.lorcanaTheFirstChapter,
        "d23-collection": setIds.lorcanaD23Collection,
      },
    },
  };
}

async function reconcileReferenceType(services: CatalogServices, def: ReferenceTypeDef): Promise<void> {
  const streamId = `catalog.reference-type-${def.referenceTypeId}`;
  const referenceDataProjector = services.referenceData.projectors.find(
    (projector) => projector.projectionName === "catalog-reference-data-projection",
  );
  if (!referenceDataProjector) {
    throw new Error("Catalog integration bootstrap is missing the Reference Data projector.");
  }

  const recovery = await retryLocalProjectionBlockedStream("catalog", services.pool, referenceDataProjector, streamId);
  if (recovery.state === "still-blocked") {
    throw new Error(
      `Catalog integration bootstrap could not recover blocked reference type '${def.key}': ${recovery.errorMessage ?? "unknown projection error"}`,
    );
  }
  if (recovery.state === "resolved") {
    console.log(`  Reference Type "${def.name}" projection stream recovered`);
  }

  const aggregate = await loadSeedAggregateState<typeof initialReferenceTypeState, ReferenceTypeEvent>({
    db: services.db,
    aggregateName: "Reference Type",
    streamId,
    createdEventType: "catalog.reference-type.created",
    createdIdField: "referenceTypeId",
    expectedId: def.referenceTypeId,
    expectedKey: def.key,
    initialState: initialReferenceTypeState,
    evolve: evolveReferenceType,
  });
  if (aggregate.kind === "absent") {
    await createReferenceType(services, def);
    return;
  }

  const existingAttributeKeys = asStrings(aggregate.state.attributeKeys);
  const missingAttributeKeys = def.attributeKeys.filter((key) => !existingAttributeKeys.includes(key));
  if (missingAttributeKeys.length > 0) {
    await sendSeedCommand(services.referenceData.referenceTypeCommandHandler, streamId, {
      type: "ReviseReferenceType",
      key: def.key,
      name: aggregate.state.name ?? localizedTextMapFromEnglish(def.name),
      description: aggregate.state.description,
      attributeKeys: [...new Set([...existingAttributeKeys, ...def.attributeKeys])].sort(),
    });
    console.log(`  Reference Type "${def.name}" reconciled with additive attributes`);
  }

  if (aggregate.kind === "draft") {
    await sendSeedCommand(services.referenceData.referenceTypeCommandHandler, streamId, {
      type: "PublishReferenceType",
    });
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function reconcileReferenceRecord(services: CatalogServices, def: ReferenceRecordDef): Promise<void> {
  const streamId = `catalog.reference-record-${def.referenceRecordId}`;
  const aggregate = await loadSeedAggregateState<typeof initialReferenceRecordState, ReferenceRecordEvent>({
    db: services.db,
    aggregateName: "Reference Record",
    streamId,
    createdEventType: "catalog.reference-record.created",
    createdIdField: "referenceRecordId",
    expectedId: def.referenceRecordId,
    expectedKey: def.key,
    keyScope: { field: "typeKey", value: def.typeKey },
    initialState: initialReferenceRecordState,
    evolve: evolveReferenceRecord,
    validateIdentity: (state) => {
      if (state.typeKey !== def.typeKey) {
        throw new Error(
          `Catalog integration bootstrap Reference Record '${def.key}' expected type key '${def.typeKey}', but found '${state.typeKey ?? "null"}'.`,
        );
      }
    },
  });
  if (aggregate.kind === "absent") {
    await createReferenceRecord(services, def);
    return;
  }
  if (aggregate.kind === "draft") {
    await sendSeedCommand(services.referenceData.referenceRecordCommandHandler, streamId, {
      type: "PublishReferenceRecord",
    });
  }
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

function magicSet(
  key: string,
  name: string,
  referenceRecordId: ReferenceRecordId,
  attributes: Readonly<Record<string, CatalogValue>>,
): ReferenceRecordDef {
  return {
    referenceRecordId,
    typeKey: "set",
    key,
    name,
    description: `${name} Magic: The Gathering set.`,
    attributes,
    relationships: [{ relationshipType: "part-of", referenceId: magicProductLineId }],
  };
}

function onePieceSet(
  key: string,
  name: string,
  referenceRecordId: ReferenceRecordId,
  attributes: Readonly<Record<string, CatalogValue>>,
): ReferenceRecordDef {
  return {
    referenceRecordId,
    typeKey: "set",
    key,
    name,
    description: `${name} One Piece Card Game set.`,
    attributes,
    relationships: [{ relationshipType: "part-of", referenceId: onePieceProductLineId }],
  };
}

function lorcanaSet(
  key: string,
  name: string,
  referenceRecordId: ReferenceRecordId,
  attributes: Readonly<Record<string, CatalogValue>>,
): ReferenceRecordDef {
  return {
    referenceRecordId,
    typeKey: "set",
    key,
    name,
    description: `${name} Disney Lorcana set.`,
    attributes,
    relationships: [{ relationshipType: "part-of", referenceId: lorcanaProductLineId }],
  };
}

async function seedOnePieceReferenceAliases(services: CatalogServices): Promise<void> {
  const aliases = [
    buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: setIds.romanceDawn, targetKey: "set" },
      aliasText: "OP-01",
      aliasLanguageCode: "en",
      sourceLanguageCode: "en",
      aliasType: "set-equivalent",
      confidence: "exact",
      reviewStatus: "auto-accepted",
      provenance: {
        providerKey: "catalog-seed",
        observationId: null,
        sourceCategory: "curated-operator-mapping",
        sourceProfileKey: "catalog-seed-one-piece-reference-aliases",
        sourceProfileVersion: "2026.06.23",
        mappingFingerprint: "catalog-seed-one-piece-reference-aliases-v1",
      },
      evidence: {
        source: "catalog-seed",
        setKey: "romance-dawn",
        setCode: "OP-01",
      },
    }),
  ];

  for (const candidate of aliases) {
    if (await referenceAliasExists(services, candidate.aliasHash)) {
      continue;
    }

    await sendSeedCommand(
      services.catalogAliases.catalogAliasCommandHandler,
      catalogAliasStreamId(candidate.aliasHash),
      {
        type: "ProposeCatalogAlias",
        candidate,
        actor: "system",
      },
    );
  }
}

async function seedLorcanaReferenceAliases(services: CatalogServices): Promise<void> {
  const aliases = [
    buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: setIds.lorcanaTheFirstChapter, targetKey: "set" },
      aliasText: "1",
      aliasLanguageCode: "en",
      sourceLanguageCode: "en",
      aliasType: "set-equivalent",
      confidence: "exact",
      reviewStatus: "auto-accepted",
      provenance: {
        providerKey: "catalog-seed",
        observationId: null,
        sourceCategory: "curated-operator-mapping",
        sourceProfileKey: "catalog-seed-lorcana-reference-aliases",
        sourceProfileVersion: "2026.06.23",
        mappingFingerprint: "catalog-seed-lorcana-reference-aliases-v1",
      },
      evidence: {
        source: "catalog-seed",
        setKey: "the-first-chapter",
        setCode: "1",
      },
    }),
    buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: setIds.lorcanaD23Collection, targetKey: "set" },
      aliasText: "D23",
      aliasLanguageCode: "en",
      sourceLanguageCode: "en",
      aliasType: "set-equivalent",
      confidence: "exact",
      reviewStatus: "auto-accepted",
      provenance: {
        providerKey: "catalog-seed",
        observationId: null,
        sourceCategory: "curated-operator-mapping",
        sourceProfileKey: "catalog-seed-lorcana-reference-aliases",
        sourceProfileVersion: "2026.06.23",
        mappingFingerprint: "catalog-seed-lorcana-reference-aliases-v1",
      },
      evidence: {
        source: "catalog-seed",
        setKey: "d23-collection",
        setCode: "D23",
      },
    }),
  ];

  for (const candidate of aliases) {
    if (await referenceAliasExists(services, candidate.aliasHash)) {
      continue;
    }

    await sendSeedCommand(
      services.catalogAliases.catalogAliasCommandHandler,
      catalogAliasStreamId(candidate.aliasHash),
      {
        type: "ProposeCatalogAlias",
        candidate,
        actor: "system",
      },
    );
  }
}

async function referenceAliasExists(services: CatalogServices, aliasHash: string): Promise<boolean> {
  const events = await loadSeedStreamEvents<CatalogAliasEvent>(services.db, catalogAliasStreamId(aliasHash));
  if (events.length === 0) {
    return false;
  }
  const state = events.reduce(evolveCatalogAlias, initialCatalogAliasState);
  if (state.aliasHash !== aliasHash) {
    throw new Error(
      `Catalog integration bootstrap Reference Alias expected hash '${aliasHash}', but found '${state.aliasHash ?? "null"}'.`,
    );
  }
  return state.reviewStatus === "accepted" || state.reviewStatus === "auto-accepted";
}

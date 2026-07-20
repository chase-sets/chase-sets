import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type {
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSetReferenceNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationLorcanaCardPrintNormalized,
  SourceObservationLorcanaSetReferenceNormalized,
  SourceObservationLorcanaSealedProductNormalized,
  SourceObservationNormalized,
  SourceObservationOnePieceCardPrintNormalized,
  SourceObservationOnePieceSetReferenceNormalized,
  SourceObservationOnePieceSealedProductNormalized,
  SourceObservationPokemonCardNormalized,
} from "../domain/domain";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderIntegrationProfileVersions,
  selectActiveCatalogProviderProfileVersion,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import type {
  TcgplayerAutomationCatalogClient,
  TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";

export const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_test" as AccountId,
  },
};

export type ReferenceTypeRow = {
  reference_type_id: string;
  key: string;
};

export type ReferenceRecordRow = {
  reference_record_id: string;
  type_key: string;
  key: string;
  attributes: Readonly<Record<string, JsonValue>>;
};

export function createActiveTcgplayerProfileVersions(input: { profileKey?: string } = {}): {
  listProfileVersions: (
    providerKey?: string | null,
  ) => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  getActiveProfileVersion: (providerKey: string) => Promise<CatalogProviderIntegrationProfileVersionRecord | null>;
} {
  const activeProfileKey = input.profileKey ?? "pokemon-single-card-product-sku";
  const versions = catalogProviderIntegrationProfileVersions.map((version) =>
    version.providerKey === "tcgplayer"
      ? {
          ...version,
          lifecycle: version.profileKey === activeProfileKey ? ("active" as const) : ("test" as const),
          active: version.profileKey === activeProfileKey,
          profile: {
            ...version.profile,
            status: version.profileKey === activeProfileKey ? ("active" as const) : ("planned" as const),
          },
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: version.profileKey === activeProfileKey ? ("active" as const) : ("test" as const),
              }
            : undefined,
        }
      : version,
  );
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string, selector?: CatalogProviderProfileVersionSelector | null) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return selectActiveCatalogProviderProfileVersion(
        normalizedProviderKey,
        versions.filter(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ),
        selector,
      );
    },
  };
}

export function createMutableProfileVersionReader(
  initialVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
) {
  let versions = [...initialVersions];
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string, selector?: CatalogProviderProfileVersionSelector | null) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return selectActiveCatalogProviderProfileVersion(
        normalizedProviderKey,
        versions.filter(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ),
        selector,
      );
    },
    activate: (providerKey: string, profileVersion: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      versions = versions.map((version) => {
        if (version.providerKey !== normalizedProviderKey) {
          return version;
        }
        const active = version.profileVersion === profileVersion;
        return {
          ...version,
          lifecycle: active ? ("active" as const) : ("deprecated" as const),
          active,
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: active ? ("active" as const) : ("deprecated" as const),
              }
            : undefined,
        };
      });
    },
  };
}

export function tcgdexProfileVersion(input: {
  profileVersion: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  active: boolean;
  displayName: string;
}): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();
  return {
    ...base,
    profileVersion: input.profileVersion,
    lifecycle: input.lifecycle,
    active: input.active,
    profile: {
      ...base.profile,
      displayName: input.displayName,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion: input.profileVersion,
          lifecycle: input.lifecycle,
        }
      : undefined,
  };
}

export function providerProfileVersionForProvider(
  providerKey: string,
  profileKey: string,
  profileVersion: string,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();

  return {
    ...base,
    providerKey,
    profileKey,
    profileVersion,
    lifecycle: "active",
    active: true,
    profile: {
      ...base.profile,
      providerKey,
      displayName: `${providerKey} Pokemon profile`,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          providerKey,
          profileKey,
          profileVersion,
          lifecycle: "active",
        }
      : undefined,
  };
}

export function tcgdexProfileSnapshot(profileVersion: string): Record<string, unknown> {
  return {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion,
    ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(currentTcgdexProfileVersion()),
    lifecycle: "active",
    connectorKind: "tcgdex-json",
    connectorSourceVersion: null,
    sourceMappingFingerprint: `fingerprint:${profileVersion}`,
  };
}

export function currentTcgdexProfileVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!version) {
    throw new Error("Expected seeded TCGdex profile version.");
  }
  return version;
}

export function pokemonObservation(input: {
  expansionName: string;
  seriesName: string;
  cardNumber?: string;
  expansionCardCount?: number | null;
  name?: string;
  rarity?: string | null;
  cardVariantKey?: string;
  cardVariantLabel?: string;
  cardVariantSourceKey?: string | null;
  parallelSet?: boolean;
}): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: input.name ?? "Furret",
    cardNumber: input.cardNumber ?? "136",
    setId: "me02.5",
    setName: input.expansionName,
    expansionId: "me02.5",
    expansionName: input.expansionName,
    expansionAbbreviation: "MEH",
    expansionCardCount: input.expansionCardCount === undefined ? 217 : input.expansionCardCount,
    expansionParallelSetCardCount: 78,
    seriesId: "me",
    seriesName: input.seriesName,
    rarity: input.rarity ?? "Uncommon",
    illustrator: "tetsuya koizumi",
    releaseDate: "2026-05-18",
    releaseYear: 2026,
    category: "Pokemon",
    imageBaseUrl: null,
    imageUrls: [],
    productAssetSet: null,
    parallelSet: input.parallelSet ?? true,
    cardVariantKey: input.cardVariantKey ?? "reverse-holo",
    cardVariantLabel: input.cardVariantLabel ?? "Parallel Set - Reverse Foil",
    cardVariantSourceKey: input.cardVariantSourceKey ?? "reverse",
    cardVariantIsPrimaryImage: false,
    imageDisclaimer:
      "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
    variants: {},
  };
}

export function magicCardPrintObservation(
  input: Partial<SourceObservationMagicCardPrintNormalized> = {},
): SourceObservationMagicCardPrintNormalized {
  return {
    kind: "magic-card-print",
    tcg: "magic",
    languageCode: "en",
    name: "Fury Sliver",
    cardNumber: "157",
    setCode: "tsp",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    setId: "00000000-0000-0000-0000-000000000tsp",
    oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
    rarity: "Rare",
    illustrator: "Paolo Parente",
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    cardVariantKey: "standard",
    cardVariantLabel: "Standard",
    imageUrls: [],
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Fury Sliver",
      collectorNumber: "157",
      languageCode: "en",
      productForm: "magic-card-print",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function magicSealedProductObservation(
  input: Partial<SourceObservationMagicSealedProductNormalized> = {},
): SourceObservationMagicSealedProductNormalized {
  return {
    kind: "magic-sealed-product",
    tcg: "magic",
    languageCode: "en",
    name: "Time Spiral Booster Pack",
    cardNumber: null,
    setCode: "tsp",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    setId: "1001",
    sealedProductForm: "booster-pack",
    packCount: 1,
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    productLineName: "Magic: The Gathering",
    barcode: "0653569123456",
    imageUrls: [],
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Time Spiral Booster Pack",
      collectorNumber: "PACK",
      languageCode: "en",
      productForm: "sealed",
      barcode: "0653569123456",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function magicSetReferenceObservation(
  input: Partial<SourceObservationMagicSetReferenceNormalized> = {},
): SourceObservationMagicSetReferenceNormalized {
  return {
    kind: "magic-set-reference",
    tcg: "magic",
    languageCode: "en",
    name: "Time Spiral",
    cardNumber: null,
    setCode: "TSP",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    setId: "00000000-0000-0000-0000-000000000tsp",
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    cardCount: 301,
    productLineName: "Magic: The Gathering",
    imageUrls: [],
    externalCatalogItemReferences: [],
    ...input,
  };
}

export function lorcanaCardPrintObservation(
  input: Partial<SourceObservationLorcanaCardPrintNormalized> = {},
): SourceObservationLorcanaCardPrintNormalized {
  return {
    kind: "lorcana-card-print",
    tcg: "lorcana",
    languageCode: "en",
    name: "Elsa - Snow Queen",
    cardNumber: "41",
    setId: "1",
    setCode: "TFC",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    rarity: "Legendary",
    cardType: "Storyborn Hero Queen Sorcerer",
    inkColor: "Amethyst",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    productLineName: "Disney Lorcana",
    imageUrls: [],
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: "The First Chapter",
      printedProductName: "Elsa - Snow Queen",
      collectorNumber: "41",
      languageCode: "en",
      productForm: "lorcana-card-print",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function lorcanaSealedProductObservation(
  input: Partial<SourceObservationLorcanaSealedProductNormalized> = {},
): SourceObservationLorcanaSealedProductNormalized {
  return {
    kind: "lorcana-sealed-product",
    tcg: "lorcana",
    languageCode: "en",
    name: "The First Chapter Booster Box",
    cardNumber: null,
    setId: "1",
    setCode: "TFC",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    sealedProductForm: "booster-box",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    productLineName: "Disney Lorcana",
    barcode: null,
    imageUrls: [],
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: "The First Chapter",
      printedProductName: "The First Chapter Booster Box",
      collectorNumber: null,
      languageCode: "en",
      productForm: "booster-box",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function lorcanaSetReferenceObservation(
  input: Partial<SourceObservationLorcanaSetReferenceNormalized> = {},
): SourceObservationLorcanaSetReferenceNormalized {
  return {
    kind: "lorcana-set-reference",
    tcg: "lorcana",
    languageCode: "en",
    name: "The First Chapter",
    cardNumber: null,
    setId: "1",
    setCode: "TFC",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    cardCount: 204,
    productLineName: "Disney Lorcana",
    imageUrls: [],
    externalCatalogItemReferences: [],
    ...input,
  };
}

export function onePieceCardPrintObservation(
  input: Partial<SourceObservationOnePieceCardPrintNormalized> = {},
): SourceObservationOnePieceCardPrintNormalized {
  return {
    kind: "one-piece-card-print",
    tcg: "one-piece",
    languageCode: "en",
    name: "Monkey.D.Luffy",
    cardNumber: "OP01-001",
    setId: "op01",
    setCode: "OP01",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    rarity: "L",
    cardType: "Leader",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    imageUrls: [],
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Monkey.D.Luffy",
      collectorNumber: "OP01-001",
      languageCode: "en",
      productForm: "one-piece-card-print",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function onePieceSealedProductObservation(
  input: Partial<SourceObservationOnePieceSealedProductNormalized> = {},
): SourceObservationOnePieceSealedProductNormalized {
  return {
    kind: "one-piece-sealed-product",
    tcg: "one-piece",
    languageCode: "en",
    name: "Romance Dawn Booster Box",
    cardNumber: null,
    setId: "op01",
    setCode: "OP01",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    sealedProductForm: "booster-box",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    barcode: null,
    imageUrls: [],
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Romance Dawn Booster Box",
      collectorNumber: null,
      languageCode: "en",
      productForm: "booster-box",
    },
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...input,
  };
}

export function onePieceSetReferenceObservation(
  input: Partial<SourceObservationOnePieceSetReferenceNormalized> = {},
): SourceObservationOnePieceSetReferenceNormalized {
  return {
    kind: "one-piece-set-reference",
    tcg: "one-piece",
    languageCode: "en",
    name: "Romance Dawn",
    cardNumber: null,
    setId: "op01",
    setCode: "OP01",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    cardCount: 121,
    productLineName: "One Piece Card Game",
    imageUrls: [],
    externalCatalogItemReferences: [],
    ...input,
  };
}

export function sourceObservationDetailRow(overrides: Record<string, unknown> = {}) {
  const normalized = pokemonObservation({
    expansionName: "Base Set",
    seriesName: "Base",
    name: "Selected Observation",
  });

  return {
    observation_id: "obs_selected",
    sync_run_id: "job_sync_selected",
    provider_key: "tcgdex",
    external_key: "base1-1",
    source_url: "https://api.tcgdex.net/v2/en/cards/base1-1",
    language_code: "en",
    source_record_hash: "hash-selected",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    source_mapping_fingerprint: "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "base1-1" },
    status: "promoted",
    status_reason: null,
    promoted_catalog_item_id: "cat_selected",
    promoted_reference_record_id: null,
    promoted_at: "2026-05-20T00:01:00.000Z",
    promotion_profile_key: "pokemon-tcg",
    promotion_profile_version: "2026.06.03",
    promotion_plan_fingerprint: "plan-fingerprint:2026.06.03",
    updated_at: "2026-05-20T00:01:00.000Z",
    ...overrides,
  };
}

export function createTcgplayerImportHarness(
  input: { failProductIds?: ReadonlySet<number>; productDomain?: "pokemon" | "mtg" | "one-piece" } = {},
) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const productDomain = input.productDomain ?? "pokemon";
  const productDetails = new Map<number, TcgplayerAutomationProductDetail>(
    productDomain === "mtg"
      ? [
          [
            14240,
            tcgplayerMagicProductDetail({ productId: 14240, productName: "Fury Sliver", number: "157", sku: 50014240 }),
          ],
          [
            96601,
            tcgplayerMagicProductDetail({
              productId: 96601,
              productName: "Time Spiral Booster Pack",
              number: "PACK",
              sku: 50096601,
              sealed: true,
              productTypeName: "Sealed Products",
            }),
          ],
        ]
      : productDomain === "one-piece"
        ? [
            [
              987650,
              tcgplayerOnePieceProductDetail({
                productId: 987650,
                productName: "Monkey.D.Luffy",
                number: "OP01-001",
                sku: 900987650,
              }),
            ],
            [
              987660,
              tcgplayerOnePieceProductDetail({
                productId: 987660,
                productName: "Romance Dawn Booster Box",
                number: "BOX",
                sku: 900987660,
                sealed: true,
                productTypeName: "Sealed Products",
              }),
            ],
          ]
        : [
            [
              610001,
              tcgplayerProductDetail({ productId: 610001, productName: "Eevee ex", number: "131", sku: 987654 }),
            ],
            [
              610002,
              tcgplayerProductDetail({ productId: 610002, productName: "Umbreon ex", number: "161", sku: 987655 }),
            ],
          ],
  );
  const client: TcgplayerAutomationCatalogClient = {
    listProductLines: async () => [
      {
        productLineId: 3,
        productLineName: "Pokemon",
        productLineUrlName: "pokemon",
        isDirect: true,
      },
      {
        productLineId: 1,
        productLineName: "Magic",
        productLineUrlName: "magic",
        isDirect: true,
      },
      {
        productLineId: 68,
        productLineName: "One Piece Card Game",
        productLineUrlName: "one-piece-card-game",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async ({ categoryId }) => {
      if (categoryId === 1) {
        return {
          errors: [],
          results: [
            {
              setNameId: 1001,
              categoryId: 1,
              name: "Time Spiral",
              cleanSetName: "Time Spiral",
              urlName: "time-spiral",
              abbreviation: "TSP",
              releaseDate: "2006-10-06",
              isSupplemental: false,
              active: true,
            },
          ],
        };
      }
      if (categoryId === 68) {
        return {
          errors: [],
          results: [
            {
              setNameId: 12001,
              categoryId: 68,
              name: "Romance Dawn",
              cleanSetName: "Romance Dawn",
              urlName: "romance-dawn",
              abbreviation: "OP-01",
              releaseDate: "2022-12-02",
              isSupplemental: false,
              active: true,
            },
          ],
        };
      }
      return {
        errors: [],
        results: [
          {
            setNameId: 7001,
            categoryId: 3,
            name: "Prismatic Evolutions",
            cleanSetName: "Prismatic Evolutions",
            urlName: "prismatic-evolutions",
            abbreviation: "PRE",
            releaseDate: "2025-01-17",
            isSupplemental: false,
            active: true,
          },
        ],
      };
    },
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => {
      if (productDomain === "mtg") {
        return [
          {
            productId: 14240,
            productName: "Fury Sliver",
            productLineId: 1,
            productLineName: "Magic",
            productTypeName: "Cards",
            setId: 1001,
            setName: "Time Spiral",
            setUrlName: "time-spiral",
            rarityName: "Uncommon",
            sealed: false,
            productStatusId: 1,
            customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
          },
          {
            productId: 96601,
            productName: "Time Spiral Booster Pack",
            productLineId: 1,
            productLineName: "Magic",
            productTypeName: "Sealed Products",
            setId: 1001,
            setName: "Time Spiral",
            setUrlName: "time-spiral",
            rarityName: "Sealed",
            sealed: true,
            productStatusId: 1,
            customAttributes: { number: "PACK", releaseDate: "2006-10-06", cardType: ["Sealed"] },
          },
        ];
      }
      if (productDomain === "one-piece") {
        return [
          {
            productId: 987650,
            productName: "Monkey.D.Luffy",
            productLineId: 68,
            productLineName: "One Piece Card Game",
            productTypeName: "Cards",
            setId: 12001,
            setName: "Romance Dawn",
            setUrlName: "romance-dawn",
            rarityName: "Leader",
            sealed: false,
            productStatusId: 1,
            customAttributes: { number: "OP01-001", releaseDate: "2022-12-02", cardType: ["Leader"] },
          },
          {
            productId: 987660,
            productName: "Romance Dawn Booster Box",
            productLineId: 68,
            productLineName: "One Piece Card Game",
            productTypeName: "Sealed Products",
            setId: 12001,
            setName: "Romance Dawn",
            setUrlName: "romance-dawn",
            rarityName: "Sealed",
            sealed: true,
            productStatusId: 1,
            customAttributes: { number: "BOX", releaseDate: "2022-12-02", cardType: ["Sealed"] },
          },
        ];
      }
      return [
        {
          productId: 610001,
          productName: "Eevee ex",
          productLineId: 3,
          productLineName: "Pokemon",
          productTypeName: "Cards",
          setId: 7001,
          setName: "Prismatic Evolutions",
          setUrlName: "prismatic-evolutions",
          rarityName: "Special Illustration Rare",
          sealed: false,
          productStatusId: 1,
          customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
        },
        {
          productId: 610002,
          productName: "Umbreon ex",
          productLineId: 3,
          productLineName: "Pokemon",
          productTypeName: "Cards",
          setId: 7001,
          setName: "Prismatic Evolutions",
          setUrlName: "prismatic-evolutions",
          rarityName: "Special Illustration Rare",
          sealed: false,
          productStatusId: 1,
          customAttributes: { number: "161", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
        },
      ];
    },
    getProductDetail: async ({ productId }) => {
      if (input.failProductIds?.has(productId)) {
        throw new Error(`Product ${productId} unavailable.`);
      }
      const detail = productDetails.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
  const deps = {
    db: {
      query: async <T>() => ({ rowCount: 0, rows: [] as T[] }),
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (eventInput: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...eventInput.events);
        return eventInput.events.map((event, index) =>
          storedEvent(index + 1, eventInput.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: client,
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    client,
    appendedSourceEvents,
  };
}

export function tcgplayerProductDetail(input: {
  productId: number;
  productName: string;
  number: string;
  sku: number;
}): TcgplayerAutomationProductDetail {
  return {
    productTypeName: "Cards",
    rarityName: "Special Illustration Rare",
    sealed: false,
    productName: input.productName,
    setId: 7001,
    setCode: "PRE",
    productId: input.productId,
    setName: "Prismatic Evolutions",
    productLineId: 3,
    productStatusId: 1,
    productLineName: "Pokemon",
    customAttributes: {
      number: input.number,
      releaseDate: "2025-01-17",
      cardType: ["Pokemon"],
    },
    formattedAttributes: {
      Artist: "Catalog Artist",
    },
    skus: [
      {
        sku: input.sku,
        condition: "Near Mint",
        variant: "Normal",
        language: "English",
      },
    ],
    marketPrice: 12.34,
    lowestPrice: 10.01,
    lowestPriceWithShipping: 11.23,
    medianPrice: 12.5,
    listings: 25,
  };
}

export function tcgplayerMagicProductDetail(input: {
  productId: number;
  productName: string;
  number: string;
  sku: number;
  sealed?: boolean;
  productTypeName?: string;
}): TcgplayerAutomationProductDetail {
  const sealed = input.sealed ?? false;
  return {
    productTypeName: input.productTypeName ?? "Cards",
    rarityName: sealed ? "Sealed" : "Uncommon",
    sealed,
    productName: input.productName,
    setId: 1001,
    setCode: "TSP",
    productId: input.productId,
    setName: "Time Spiral",
    productLineId: 1,
    productStatusId: 1,
    productLineName: "Magic",
    customAttributes: {
      number: input.number,
      releaseDate: "2006-10-06",
      cardType: sealed ? ["Sealed"] : ["Creature"],
      barcode: sealed ? "0653569123456" : undefined,
    },
    formattedAttributes: {
      Artist: "Paolo Parente",
    },
    skus: [
      {
        sku: input.sku,
        condition: sealed ? "Sealed" : "Near Mint",
        variant: sealed ? "Sealed" : "Normal",
        language: "English",
      },
    ],
    marketPrice: 1.23,
    lowestPrice: 1.01,
    lowestPriceWithShipping: 1.23,
    medianPrice: 1.5,
    listings: 25,
  };
}

export function tcgplayerOnePieceProductDetail(input: {
  productId: number;
  productName: string;
  number: string;
  sku: number;
  sealed?: boolean;
  productTypeName?: string;
}): TcgplayerAutomationProductDetail {
  const sealed = input.sealed ?? false;
  return {
    productTypeName: input.productTypeName ?? "Cards",
    rarityName: sealed ? "Sealed" : "Leader",
    sealed,
    productName: input.productName,
    setId: 12001,
    setCode: "OP-01",
    productId: input.productId,
    setName: "Romance Dawn",
    productLineId: 68,
    productStatusId: 1,
    productLineName: "One Piece Card Game",
    customAttributes: {
      number: input.number,
      releaseDate: "2022-12-02",
      cardType: sealed ? ["Sealed"] : ["Leader"],
    },
    formattedAttributes: {
      Artist: "Eiichiro Oda",
    },
    skus: [
      {
        sku: input.sku,
        condition: sealed ? "Sealed" : "Near Mint",
        variant: sealed ? "Sealed" : "Normal",
        language: "English",
      },
    ],
    marketPrice: sealed ? 99.99 : 4.25,
    lowestPrice: sealed ? 89.99 : 3.75,
    lowestPriceWithShipping: sealed ? 99.99 : 4.99,
    medianPrice: sealed ? 109.99 : 4.5,
    listings: sealed ? 12 : 25,
  };
}

export function createIntegrationJobDedupeHarness(
  input: {
    existingJob?: Record<string, unknown>;
    recentJobs?: readonly Record<string, unknown>[];
    reapplyObservationIds?: readonly string[];
    acceptedScopeMappings?: readonly Record<string, unknown>[];
  } = {},
) {
  let existingJob = input.existingJob ? { ...input.existingJob } : undefined;
  const recentJobs = input.recentJobs ? input.recentJobs.map((job) => ({ ...job })) : [];
  const insertedJobs: Record<string, unknown>[] = [];
  const insertedWorkUnits: Array<Readonly<{ unitId: string; unitKind: string; payload: Record<string, unknown> }>> = [];
  const jobEvents: Record<string, unknown>[] = [];
  let queryCount = 0;
  let activeLookupValues: readonly unknown[] = [];
  let recentLookupValues: readonly unknown[] = [];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        queryCount += 1;

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status IN ('queued', 'running')")
        ) {
          activeLookupValues = values;
          return {
            rowCount: existingJob ? 1 : 0,
            rows: (existingJob ? [existingJob] : []) as T[],
          };
        }

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("ORDER BY updated_at DESC")
        ) {
          recentLookupValues = values;
          return {
            rowCount: recentJobs.length,
            rows: recentJobs as T[],
          };
        }

        if (sql.includes("SELECT observation_id FROM catalog_source_observations")) {
          const rows = (input.reapplyObservationIds ?? []).map((observationId) => ({
            observation_id: observationId,
          }));
          return { rowCount: rows.length, rows: rows as T[] };
        }

        if (sql.includes("FROM catalog_provider_scope_mappings")) {
          const rows = input.acceptedScopeMappings ?? [];
          return { rowCount: rows.length, rows: rows as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_durable_jobs")) {
          const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
          const row =
            values[1] === "catalog-sync-scope"
              ? {
                  job_id: String(values[0]),
                  job_kind: String(values[1]),
                  payload,
                  event_context: JSON.parse(String(values[4])) as EventStoreContext,
                  status: "queued",
                  progress: JSON.parse(String(values[3])) as Record<string, unknown>,
                  result: null,
                  error_message: null,
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: null,
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:00.000Z",
                }
              : integrationJobRow({
                  jobId: String(values[0]),
                  action: String(values[1]),
                  scope: payload.scope as Record<string, unknown>,
                  syncRunId: payload.syncRunId as string | null,
                  profileSnapshot: payload.profileSnapshot as Record<string, unknown> | null,
                  reapplyProfileMode: payload.reapplyProfileMode as string | null,
                  eventContext: JSON.parse(String(values[4])) as EventStoreContext,
                  progress: JSON.parse(String(values[3])) as Record<string, unknown>,
                });
          insertedJobs.push(row);
          return { rowCount: 1, rows: [row] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: Record<string, unknown>;
          }>;
          insertedWorkUnits.push(
            ...units.map((unit) => ({
              unitId: unit.unit_id,
              unitKind: unit.unit_kind,
              payload: unit.payload,
            })),
          );
          return { rowCount: units.length, rows: [] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          jobEvents.push({
            jobKind: "integration",
            jobId: values[0],
            snapshot: JSON.parse(String(values[1])) as Record<string, unknown>,
          });
          return { rowCount: 1, rows: [{ sequence: jobEvents.length }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("job_kind = 'catalog-sync-scope'")
        ) {
          const row = insertedJobs.find((job) => job.job_id === values[0]);
          if (!row) {
            return { rowCount: 0, rows: [] as T[] };
          }
          row.status = values[1] as string;
          row.progress = JSON.parse(String(values[2])) as Record<string, unknown>;
          row.result = JSON.parse(String(values[3])) as Record<string, unknown>;
          row.error_message = values[4] as string | null;
          row.completed_at = "2026-05-28T00:00:10.000Z";
          row.updated_at = "2026-05-28T00:00:10.000Z";
          return { rowCount: 1, rows: [row] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("completed_at = NULL") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "queued",
            progress: JSON.parse(String(values[1])),
            result: values[2] == null ? currentJob.result : JSON.parse(String(values[2])),
            error_message: values[3] as string | null,
            claim_owner_id: null,
            claimed_until: null,
            completed_at: null,
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status = 'failed'") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "failed",
            progress: JSON.parse(String(values[1])),
            error_message: String(values[2]),
            claim_owner_id: null,
            claimed_until: null,
            completed_at: "2026-05-28T00:00:10.000Z",
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("WHERE job_id = $1")
        ) {
          const row =
            existingJob?.job_id === values[0] ? existingJob : insertedJobs.find((job) => job.job_id === values[0]);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async () => [],
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    insertedJobs,
    insertedWorkUnits,
    jobEvents,
    get activeLookupValues() {
      return activeLookupValues;
    },
    get recentLookupValues() {
      return recentLookupValues;
    },
    get queryCount() {
      return queryCount;
    },
  };
}

export function integrationJobRow(input: {
  jobId: string;
  action: string;
  scope: Record<string, unknown>;
  profileSnapshot?: Record<string, unknown> | null;
  reapplyProfileMode?: string | null;
  syncRunId?: string | null;
  eventContext: EventStoreContext;
  progress?: Record<string, unknown>;
}) {
  return {
    job_id: input.jobId,
    job_kind: input.action,
    payload: {
      action: input.action,
      scope: input.scope,
      syncRunId: input.syncRunId ?? null,
      profileSnapshot: input.profileSnapshot ?? null,
      reapplyProfileMode: input.reapplyProfileMode ?? null,
    },
    event_context: input.eventContext,
    status: "queued",
    progress:
      input.progress ??
      ({
        phase: "queued",
        completed: 0,
        total: 0,
        currentName: null,
        status: null,
      } as const),
    result: null,
    error_message: null,
    claim_owner_id: null,
    claimed_until: null,
    attempt_count: 0,
    next_eligible_at: "2026-05-28T00:00:00.000Z",
    created_at: "2026-05-28T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    updated_at: "2026-05-28T00:00:00.000Z",
  };
}

export function createIntegrationJobClaimHandoffHarness(
  input: {
    scope?: Record<string, unknown>;
    profileSnapshot?: Record<string, unknown> | null;
    syncRunId?: string | null;
    acceptedScopeRecordId?: string;
    acceptedUnitKey?: string;
    renewSucceeds?: boolean;
    tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
  } = {},
) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let renewAttempts = 0;
  const job = {
    job_id: "job_import_base1",
    job_kind: "import",
    payload: {
      action: "import",
      scope: input.scope ?? {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      syncRunId: input.syncRunId ?? null,
      profileSnapshot: input.profileSnapshot ?? null,
    },
    event_context: context,
    status: "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    attempt_count: 0,
    next_eligible_at: "2026-05-20T00:00:00.000Z",
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (
          sql.includes("SELECT") &&
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("WHERE job_id = $1")
        ) {
          return {
            rowCount: values[0] === job.job_id ? 1 : 0,
            rows: (values[0] === job.job_id ? [job] : []) as T[],
          };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs AS job") &&
          sql.includes("SET status = 'running'")
        ) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.attempt_count += 1;
          job.next_eligible_at = "2026-05-20T00:04:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          renewAttempts += 1;
          return { rowCount: input.renewSucceeds ? 1 : 0, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_integration_durable_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_provider_scope_mappings")) {
          const scope = job.payload.scope;
          const row = input.acceptedScopeRecordId
            ? {
                mapping_id: `map_${input.acceptedScopeRecordId}`,
                scope_record_id: input.acceptedScopeRecordId,
                provider_key: String(scope.provider ?? ""),
                unit_key: input.acceptedUnitKey ?? "test-unit",
                product_line_id: typeof scope.productLineId === "string" ? scope.productLineId : null,
                series_id: typeof scope.seriesId === "string" ? scope.seriesId : null,
                set_id: typeof scope.setId === "string" ? scope.setId : null,
                set_name: typeof scope.setName === "string" ? scope.setName : null,
                language_coordinates: { languageCode: typeof scope.language === "string" ? scope.language : "en" },
                confidence: "exact",
                review_status: "accepted",
                provenance: {},
                evidence: {},
                last_actor: "test",
                last_reason: "fixture",
                policy_version: "test",
                proposed_at: "2026-05-20T00:00:00.000Z",
                reviewed_at: "2026-05-20T00:00:00.000Z",
                updated_at: "2026-05-20T00:00:00.000Z",
              }
            : null;
          return { rowCount: row ? 1 : 0, rows: (row ? [row] : []) as T[] };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return { rowCount: 1, rows: [{ reference_type_id: String(values[0]) }] as T[] };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return { rowCount: 1, rows: [{ attributes: {} }] as T[] };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return { rowCount: 1, rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(index + 1, "catalog.source-observation-obs_1", event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: input.tcgplayerAutomationCatalogClient,
  } as object as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [],
  } as object as ReferenceDataServices;

  return {
    deps,
    referenceData,
    job,
    appendedSourceEvents,
    get renewAttempts() {
      return renewAttempts;
    },
  };
}

export function createReferencePreloadHarness() {
  const referenceTypes = new Map<string, ReferenceTypeRow>();
  const referenceRecords = new Map<string, ReferenceRecordRow>();
  const referenceRecordCreateCommands: Extract<ReferenceRecordCommand, { type: "CreateReferenceRecord" }>[] = [];
  let projectorRuns = 0;

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const row = referenceTypes.get(referenceTypeId);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("WHERE type_key = $1 AND key = $2")) {
          const typeKey = String(values[0]);
          const key = String(values[1]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.key === key,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("attributes ->> $2")) {
          const typeKey = String(values[0]);
          const attributeKey = String(values[1]);
          const attributeValue = String(values[2]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
  } as object as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async (input: { command: ReferenceTypeCommand }) => {
      if (input.command.type === "CreateReferenceType") {
        referenceTypes.set(input.command.referenceTypeId, {
          reference_type_id: input.command.referenceTypeId,
          key: input.command.key,
        });
      }
    },
    referenceRecordCommandHandler: async (input: { command: ReferenceRecordCommand }) => {
      if (input.command.type === "CreateReferenceRecord") {
        referenceRecordCreateCommands.push(input.command);
        referenceRecords.set(input.command.referenceRecordId, {
          reference_record_id: input.command.referenceRecordId,
          type_key: input.command.typeKey,
          key: input.command.key,
          attributes: input.command.attributes ?? {},
        });
      }
    },
    projectors: [
      {
        runOnce: async () => {
          projectorRuns += 1;
          return { processed: 0 };
        },
      },
    ],
  } as object as ReferenceDataServices;

  return {
    deps,
    referenceData,
    referenceRecordCreateCommands,
    projectorRuns: () => projectorRuns,
    referenceRecordsByProviderAttribute(typeKey: string, attributeKey: string, attributeValue: string) {
      return Array.from(referenceRecords.values()).filter(
        (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
      );
    },
  };
}

export function createChangedObservationRefreshHarness(
  input: {
    normalized?: SourceObservationNormalized;
    providerKey?: string;
    externalKey?: string;
    sourceUrl?: string;
    sourceProfileKey?: string;
    sourceProfileVersion?: string;
    sourceMappingFingerprint?: string;
    expansionAttributes?: Readonly<Record<string, JsonValue>>;
    status?: string;
    promotedCatalogItemId?: string | null;
    promotedReferenceRecordId?: string | null;
    reusableCatalogItemId?: string | null;
    reusableExternalProductCatalogItemIds?: readonly string[];
    reusableExternalCatalogItemIds?: readonly string[];
    deterministicCatalogItemIds?: readonly string[];
    partialCatalogItemId?: string | null;
    promotionCommandAlreadyApplied?: { catalogItemId: string };
    assetStorage?: CatalogRuntimeDeps["assetStorage"];
  } = {},
) {
  const itemCommands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let itemProjectorRuns = 0;
  let referenceProjectorRuns = 0;
  const normalized =
    input.normalized ??
    pokemonObservation({
      expansionName: "Ascended Heroes Updated",
      seriesName: "Mega Evolution",
    });
  const observationRow = {
    observation_id: "obs_changed",
    sync_run_id: "job_sync_changed",
    provider_key: input.providerKey ?? "tcgdex",
    external_key: input.externalKey ?? "me02.5-136:reverse-holo",
    source_url: input.sourceUrl ?? "https://api.tcgdex.net/v2/en/cards/me02.5-136",
    language_code: "en",
    source_record_hash: "new-hash",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: input.sourceProfileKey ?? "pokemon-tcg",
    source_profile_version: input.sourceProfileVersion ?? "2026.06.03",
    source_mapping_fingerprint: input.sourceMappingFingerprint ?? "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "me02.5-136" },
    status: input.status ?? "changed",
    status_reason: null,
    promoted_catalog_item_id: input.promotedCatalogItemId === undefined ? "cat_existing" : input.promotedCatalogItemId,
    promoted_reference_record_id:
      input.promotedReferenceRecordId === undefined ? null : input.promotedReferenceRecordId,
    promoted_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const streamId = "catalog.source-observation-obs_changed";
  const observationStatus = input.status ?? "changed";
  const promotionCommandAlreadyApplied = input.promotionCommandAlreadyApplied;
  const sourceEvents = [
    storedEvent(1, streamId, "catalog.source-observation.recorded", {
      ...observationRow,
      observationId: observationRow.observation_id,
      syncRunId: observationRow.sync_run_id,
      providerKey: observationRow.provider_key,
      externalKey: observationRow.external_key,
      sourceUrl: observationRow.source_url,
      languageCode: observationRow.language_code,
      sourceRecordHash: observationStatus === "observed" ? observationRow.source_record_hash : "old-hash",
      sourceUpdatedAt: observationStatus === "observed" ? observationRow.source_updated_at : null,
      observedAt: observationStatus === "observed" ? observationRow.observed_at : "2026-05-19T00:00:00.000Z",
      sourceProfileKey: observationRow.source_profile_key,
      sourceProfileVersion: observationRow.source_profile_version,
      sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
      normalized,
      sourcePayload: observationRow.source_payload,
    }),
    ...(observationStatus === "observed"
      ? []
      : [
          observationRow.promoted_reference_record_id
            ? storedEvent(2, streamId, "catalog.source-observation.reference-promoted", {
                referenceRecordId: observationRow.promoted_reference_record_id,
                promotedAt: "2026-05-19T00:00:00.000Z",
                promotionProfileKey: observationRow.source_profile_key,
                promotionProfileVersion: observationRow.source_profile_version,
                promotionPlanFingerprint: "plan-fingerprint:2026.06.03",
              })
            : storedEvent(2, streamId, "catalog.source-observation.promoted", {
                catalogItemId: observationRow.promoted_catalog_item_id ?? "cat_existing",
                promotedAt: "2026-05-19T00:00:00.000Z",
                promotionProfileKey: observationRow.source_profile_key,
                promotionProfileVersion: observationRow.source_profile_version,
                promotionPlanFingerprint: "plan-fingerprint:2026.06.03",
              }),
        ]),
    ...(observationStatus === "changed"
      ? [
          storedEvent(3, streamId, "catalog.source-observation.changed", {
            observationId: observationRow.observation_id,
            providerKey: observationRow.provider_key,
            externalKey: observationRow.external_key,
            sourceUrl: observationRow.source_url,
            languageCode: observationRow.language_code,
            sourceRecordHash: observationRow.source_record_hash,
            sourceUpdatedAt: observationRow.source_updated_at,
            observedAt: observationRow.observed_at,
            sourceProfileKey: observationRow.source_profile_key,
            sourceProfileVersion: observationRow.source_profile_version,
            sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
            normalized,
            sourcePayload: observationRow.source_payload,
          }),
        ]
      : []),
  ];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_source_observations")) {
          return {
            rowCount: 1,
            rows: [observationRow] as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item") && sql.includes("item.status NOT IN")) {
          return {
            rowCount: input.deterministicCatalogItemIds?.length ?? 0,
            rows: (input.deterministicCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item")) {
          const row = input.partialCatalogItemId ? { catalog_item_id: input.partialCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_catalog_item_references")) {
          return {
            rowCount: input.reusableExternalCatalogItemIds?.length ?? 0,
            rows: (input.reusableExternalCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_product_references")) {
          const catalogItemIds = sql.includes("WHERE reference.provider_key = $1")
            ? input.reusableCatalogItemId
              ? [input.reusableCatalogItemId]
              : []
            : (input.reusableExternalProductCatalogItemIds ?? []);
          return {
            rowCount: catalogItemIds.length,
            rows: catalogItemIds.map((catalogItemId) => ({ catalog_item_id: catalogItemId })) as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return {
            rowCount: 1,
            rows: [{ reference_type_id: String(values[0]) }] as T[],
          };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return {
            rowCount: 1,
            rows: [{ attributes: input.expansionAttributes ?? {} }] as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return {
            rowCount: 1,
            rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[],
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return { rowCount: 1, rows: [{ id: `bpr_${String(values[0])}` }] as T[] };
        }

        if (sql.includes("FROM catalog_categories")) {
          return { rowCount: 1, rows: [{ id: `cat_${String(values[0])}` }] as T[] };
        }

        if (sql.includes("FROM catalog_fields")) {
          return { rowCount: 1, rows: [{ id: `fld_${String(values[0])}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => sourceEvents,
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        if (
          promotionCommandAlreadyApplied &&
          input.events.some((event) => event.eventType === "catalog.source-observation.promoted")
        ) {
          observationRow.status = "promoted";
          observationRow.promoted_catalog_item_id = promotionCommandAlreadyApplied.catalogItemId;
          throw new Error("Only observed or changed source observations can be promoted.");
        }
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) => storedEvent(4 + index, streamId, event.eventType, event.payload));
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    assetStorage: input.assetStorage,
  } as object as CatalogRuntimeDeps;

  const items = {
    commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
      itemCommands.push(input);
      return { version: itemCommands.length, state: { status: "draft" } };
    },
    projectors: [
      {
        runOnce: async () => {
          itemProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as object as CatalogItemServices;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [
      {
        runOnce: async () => {
          referenceProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as object as ReferenceDataServices;

  return {
    deps,
    items,
    referenceData,
    itemCommands,
    appendedSourceEvents,
    projectorRuns: () => itemProjectorRuns + referenceProjectorRuns,
  };
}

export function createBulkReviewJobHarness(
  count: number,
  options: {
    status?: "queued" | "running" | "completed" | "failed";
    progressTotal?: number;
    carriedOutcomes?: ReadonlyArray<{ observationId: string; status: "rejected"; reason?: string | null }>;
    terminalWorkUnits?: boolean;
  } = {},
) {
  const observationIds = Array.from({ length: count }, (_, index) => `obs_${index + 1}`);
  const observations = new Map(
    observationIds.map((observationId, index) => [
      observationId,
      {
        observation_id: observationId,
        sync_run_id: "job_bulk_review",
        provider_key: "tcgdex",
        external_key: `card-${index + 1}`,
        source_url: `https://api.tcgdex.net/v2/en/cards/card-${index + 1}`,
        language_code: "en",
        source_record_hash: `hash-${index + 1}`,
        source_updated_at: "2026-05-20T00:00:00.000Z",
        observed_at: "2026-05-20T00:00:00.000Z",
        source_profile_key: "pokemon-tcg",
        source_profile_version: "2026.06.03",
        source_mapping_fingerprint: "fingerprint:2026.06.03",
        normalized: pokemonObservation({
          expansionName: "Base Set",
          seriesName: "Base",
          name: `Card ${index + 1}`,
        }),
        source_payload: { id: `card-${index + 1}` },
        status: "observed",
        status_reason: null,
        promoted_catalog_item_id: null,
        promoted_reference_record_id: null,
        promoted_at: null,
        updated_at: "2026-05-20T00:00:00.000Z",
      },
    ]),
  );
  const job = {
    job_id: "job_bulk_review",
    job_kind: "reject",
    payload: {
      action: "reject",
      selectionMode: "ids",
      observationIds,
      scope: {},
      reason: "Out of scope.",
    },
    event_context: context,
    status: options.status ?? "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: options.progressTotal ?? 0,
      currentName: null,
      status: null,
    },
    result: options.carriedOutcomes
      ? ({
          requested: options.progressTotal ?? options.carriedOutcomes.length,
          rejected: options.carriedOutcomes.length,
          skipped: 0,
          failed: 0,
          outcomes: options.carriedOutcomes,
        } as Record<string, unknown>)
      : (null as null | Record<string, unknown>),
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const appendedEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const workUnits = new Map<
    string,
    {
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: { observationId: string };
      result: Record<string, unknown> | null;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: string | null;
      attempt_count: number;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }
  >();
  if (options.terminalWorkUnits) {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "completed",
        payload: { observationId },
        result: {
          observationId,
          status: "rejected",
          reason: null,
        },
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 1,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: "2026-05-20T00:00:00.000Z",
      });
    }
  } else {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "queued",
        payload: { observationId },
        result: null,
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 0,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: null,
      });
    }
  }

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: { observationId: string };
          }>;
          let inserted = 0;
          for (const unit of units) {
            if (workUnits.has(unit.unit_id)) {
              continue;
            }
            inserted += 1;
            workUnits.set(unit.unit_id, {
              unit_id: unit.unit_id,
              unit_kind: unit.unit_kind,
              state: "queued",
              payload: unit.payload,
              result: null,
              error_message: null,
              claim_owner_id: null,
              claim_token: null,
              claimed_until: null,
              attempt_count: 0,
              created_at: "2026-05-20T00:00:00.000Z",
              updated_at: "2026-05-20T00:00:00.000Z",
              completed_at: null,
            });
          }
          return { rowCount: inserted, rows: [] as T[] };
        }

        if (sql.includes("WITH workflow_budget")) {
          const unit = [...workUnits.values()].find(
            (candidate) => candidate.state === "queued" || candidate.claimed_until === "expired",
          );
          if (!unit) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = "running";
          unit.claim_owner_id = String(values[0]);
          unit.claim_token = String(values[1]);
          unit.claimed_until = "2026-05-20T00:02:00.000Z";
          unit.attempt_count += 1;
          job.status = "running";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ ...prefixedBulkJobRow(job), ...prefixedBulkWorkUnitRow(unit) }] as T[] };
        }

        if (
          sql.includes("SELECT job_id") &&
          sql.includes("FROM catalog_source_observation_bulk_review_jobs") &&
          sql.includes("FOR UPDATE")
        ) {
          return ["queued", "running"].includes(job.status)
            ? { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] }
            : { rowCount: 0, rows: [] as T[] };
        }

        if (sql.includes("state NOT IN ('completed', 'failed', 'skipped')")) {
          return {
            rowCount: 1,
            rows: [
              {
                count: [...workUnits.values()].filter(
                  (unit) => unit.state !== "completed" && unit.state !== "failed" && unit.state !== "skipped",
                ).length,
              },
            ] as T[],
          };
        }

        if (sql.includes("WITH terminal_unit")) {
          const unit = workUnits.get(String(values[1]));
          if (!unit || unit.claim_owner_id !== String(values[2]) || unit.claim_token !== String(values[3])) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = values[4] as typeof unit.state;
          unit.result = values[5] == null ? null : JSON.parse(String(values[5]));
          unit.error_message = values[6] == null ? null : String(values[6]);
          unit.claim_owner_id = null;
          unit.claim_token = null;
          unit.claimed_until = null;
          unit.completed_at = "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job") &&
          sql.includes("CASE WHEN $4::boolean")
        ) {
          job.status = values[3] === true ? "completed" : "running";
          job.progress = JSON.parse(String(values[1]));
          job.result = values[2] == null ? job.result : JSON.parse(String(values[2]));
          job.completed_at = values[3] === true ? "2026-05-20T00:00:00.000Z" : job.completed_at;
          return { rowCount: 1, rows: [prefixedBulkJobRow(job)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("count(*)::integer AS total")
        ) {
          const units = values[0]
            ? [...workUnits.values()].filter((unit) => unit.unit_id || job.job_id === values[0])
            : [...workUnits.values()];
          return { rowCount: 1, rows: [bulkWorkUnitSummaryRow(units)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("ORDER BY created_at ASC, unit_id ASC")
        ) {
          return { rowCount: workUnits.size, rows: [...workUnits.values()] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job")) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'queued'")) {
            job.status = "queued";
            job.progress = JSON.parse(String(values[2]));
            job.result = values[3] === null || values[3] === undefined ? job.result : JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
          } else if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_source_observation_bulk_review_jobs")) {
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("FROM catalog_source_observations")) {
          const row = observations.get(String(values[0]));
          return { rowCount: row ? 1 : 0, rows: (row ? [row] : []) as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async (input: { streamId: string }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (!row) {
          return [];
        }
        return [
          storedEvent(1, input.streamId, "catalog.source-observation.recorded", {
            observationId: row.observation_id,
            syncRunId: row.sync_run_id,
            providerKey: row.provider_key,
            externalKey: row.external_key,
            sourceUrl: row.source_url,
            languageCode: row.language_code,
            sourceRecordHash: row.source_record_hash,
            sourceUpdatedAt: row.source_updated_at,
            observedAt: row.observed_at,
            sourceProfileKey: row.source_profile_key,
            sourceProfileVersion: row.source_profile_version,
            sourceMappingFingerprint: row.source_mapping_fingerprint,
            normalized: row.normalized,
            sourcePayload: row.source_payload,
          }),
        ];
      },
      appendToStream: async (input: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (row) {
          row.status = "rejected";
        }
        appendedEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(2 + index, input.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    job,
    appendedEvents,
  };
}

export function prefixedBulkJobRow(job: Record<string, unknown>) {
  return {
    job_job_id: job.job_id,
    job_job_kind: job.job_kind,
    job_status: job.status,
    job_payload: job.payload,
    job_progress: job.progress,
    job_result: job.result,
    job_error_message: job.error_message,
    job_event_context: job.event_context,
    job_claim_owner_id: job.claim_owner_id,
    job_claimed_until: job.claimed_until,
    job_created_at: job.created_at,
    job_started_at: job.started_at,
    job_completed_at: job.completed_at,
    job_updated_at: job.updated_at,
  };
}

export function prefixedBulkWorkUnitRow(unit: Record<string, unknown>) {
  return {
    unit_job_id: "job_bulk_review",
    unit_unit_id: unit.unit_id,
    unit_unit_kind: unit.unit_kind,
    unit_state: unit.state,
    unit_payload: unit.payload,
    unit_result: unit.result,
    unit_error_message: unit.error_message,
    unit_claim_owner_id: unit.claim_owner_id,
    unit_claim_token: unit.claim_token,
    unit_claimed_until: unit.claimed_until,
    unit_attempt_count: unit.attempt_count,
    unit_created_at: unit.created_at,
    unit_updated_at: unit.updated_at,
    unit_completed_at: unit.completed_at,
  };
}

export function bulkWorkUnitSummaryRow(units: readonly { state: string; claimed_until: string | null }[]) {
  return {
    total: units.length,
    queued: units.filter((unit) => unit.state === "queued").length,
    running: units.filter((unit) => unit.state === "running").length,
    completed: units.filter((unit) => unit.state === "completed").length,
    failed: units.filter((unit) => unit.state === "failed").length,
    skipped: units.filter((unit) => unit.state === "skipped").length,
    active_claims: units.filter((unit) => unit.state === "running" && unit.claimed_until).length,
    expired_claims: 0,
  };
}

export function storedEvent(
  streamVersion: number,
  streamId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: `evt_${streamVersion}`,
    streamId,
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: context.tenantId,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
    recordedAt: "2026-05-20T00:00:00.000Z",
    performedByUserId: context.audit.performedByUserId,
    forAccountId: context.audit.forAccountId,
  };
}

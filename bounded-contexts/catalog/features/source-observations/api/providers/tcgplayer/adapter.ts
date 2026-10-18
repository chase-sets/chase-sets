import {
  TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
} from "./executable-mapping-contract";
import { createCatalogProviderCredentialReadiness } from "../../governance/catalog-integration-credential-readiness";
import {
  runCatalogIntegrationDryRun,
  type CatalogIntegrationDryRunResult,
  type CatalogIntegrationObservationFact,
} from "../../governance/catalog-integration-engine";
import { defineCatalogIntegrationUnitKey } from "../../governance/integration-unit";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../profile-types";
import { assembleCatalogProviderIngestionUnitProfileSections } from "../provider-profile-sections";
import type {
  CatalogIntegrationUnitDescriptor,
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

const unit = (productDomain: string, productForm: string) =>
  defineCatalogIntegrationUnitKey({
    providerKey: "tcgplayer",
    productDomain,
    productForm,
    ingestionPurpose: "source-observation-import",
  });

export const TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("pokemon", "single-card");
export const TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("mtg", "single-card");
export const TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("yugioh", "single-card");
export const TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("one-piece", "single-card");
export const TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit(
  "one-piece",
  "sealed-product",
);
export const TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("lorcana", "single-card");
export const TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("lorcana", "sealed-product");
export const TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("mtg", "sealed-product");
export const TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = unit("pokemon", "sealed-product");

type TcgplayerAutomationProductSku = Readonly<{
  sku: number;
  condition: string;
  variant: string;
  language: string;
}>;

type TcgplayerAutomationProductDetail = Readonly<{
  productTypeName: string;
  rarityName: string;
  sealed: boolean;
  productName: string;
  setId: number;
  setCode: string;
  productId: number;
  setName: string;
  productLineId: number;
  productStatusId: number;
  productLineName: string;
  customAttributes: Readonly<{
    number?: string;
    releaseDate?: string;
    cardType?: readonly string[];
  }>;
  barcode?: string;
  formattedAttributes?: Readonly<{ Artist?: string }>;
  skus: readonly TcgplayerAutomationProductSku[];
  marketPrice?: number | null;
  lowestPrice?: number | null;
  lowestPriceWithShipping?: number | null;
  medianPrice?: number | null;
  listings?: number | null;
}>;

export type TcgplayerProviderPayload = Readonly<{
  kind: "product-detail";
  detail: TcgplayerAutomationProductDetail;
}>;
export type TcgplayerProviderAdapterOptions = Readonly<{
  loadProfileVersions: () => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
}>;

const RETIRED_TCGPLAYER_HANDOFF_MESSAGE = "TCGplayer server transport is retired; use the browser handoff.";
const RETIRED_TCGPLAYER_DIAGNOSTIC_MESSAGE = "TCGplayer server transport is retired.";

const retired = () => new Error(RETIRED_TCGPLAYER_HANDOFF_MESSAGE);

export function createTcgplayerProviderAdapter(
  options: TcgplayerProviderAdapterOptions,
): ProviderAdapter<TcgplayerProviderPayload> {
  return {
    providerKey: "tcgplayer",
    capabilities: { supportsOptionQueries: false, supportsImportPlanning: false, supportsPayloadFetch: false },
    async listIntegrationUnits(): Promise<readonly CatalogIntegrationUnitDescriptor[]> {
      const versions = await options.loadProfileVersions();
      return versions.map((version) => ({
        ...assembleCatalogProviderIngestionUnitProfileSections(version).ingestionUnitIdentity.value,
        profileVersion: version.profileVersion,
      }));
    },
    async listOptions() {
      throw retired();
    },
    async planImport(_scope: ProviderImportScope): Promise<ProviderImportPlan> {
      throw retired();
    },
    async *fetchPayloads(_plan: ProviderImportPlan): AsyncIterable<ProviderPayloadEnvelope<TcgplayerProviderPayload>> {
      throw retired();
    },
    async getCredentialReadiness() {
      return [
        createCatalogProviderCredentialReadiness({
          providerKey: "tcgplayer",
          requirement: "not-required",
          sourceKind: "none",
          state: "unknown",
          diagnosticCode: "provider-retired",
          message: RETIRED_TCGPLAYER_HANDOFF_MESSAGE,
          evidence: { transport: "browser-extension-only" },
        }),
      ];
    },
    async getTransportDiagnostics() {
      return [{ code: "provider-retired", severity: "error" as const, message: RETIRED_TCGPLAYER_DIAGNOSTIC_MESSAGE }];
    },
  };
}

function detailEnvelope(
  plan: ProviderImportPlan,
  detail: TcgplayerAutomationProductDetail,
  fetchedAt: string,
): ProviderPayloadEnvelope<TcgplayerProviderPayload> {
  return {
    unitKey: plan.unitKey,
    providerKey: "tcgplayer",
    externalKey: `product:${detail.productId}`,
    payload: {
      kind: "product-detail",
      detail,
    },
    provenance: {
      sourceUrl: `https://mp-search-api.tcgplayer.com/v2/product/${detail.productId}/details`,
      sourceUpdatedAt: detail.customAttributes.releaseDate,
      fetchedAt,
    },
  };
}

export async function runTcgplayerMtgSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerMtgSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerMtgSingleCardProofDetail,
  });
}

export async function runTcgplayerMtgSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerMtgSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerMtgSealedProductProofDetail,
  });
}

export async function runTcgplayerPokemonSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerPokemonSingleCardProofDetail,
    fetchedAt: "2026-06-03T00:00:00.000Z",
  });
}

export async function runTcgplayerPokemonSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerPokemonSealedProductProofDetail,
    fetchedAt: "2026-07-13T00:00:00.000Z",
  });
}

export async function runTcgplayerYugiohSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerYugiohSingleCardProofDetail,
    fetchedAt: "2026-06-21T00:00:00.000Z",
  });
}

export async function runTcgplayerOnePieceSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerOnePieceSingleCardProofDetail,
    fetchedAt: "2026-06-22T00:00:00.000Z",
  });
}

export async function runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerOnePieceSealedProductProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
}

export async function runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerLorcanaSingleCardProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
}

export async function runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerLorcanaSealedProductProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
}

function runTcgplayerMtgSourceObservationImportProofDryRun(input: {
  unitKey:
    | typeof TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
    | typeof TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;
  profileVersion: string;
  detail: TcgplayerAutomationProductDetail;
}): CatalogIntegrationDryRunResult {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    ...input,
    fetchedAt: "2026-06-19T00:00:00.000Z",
  });
}

function runTcgplayerProviderProductSourceObservationImportProofDryRun(input: {
  unitKey: string;
  profileVersion: string;
  detail: TcgplayerAutomationProductDetail;
  fetchedAt: string;
}): CatalogIntegrationDryRunResult {
  const payload = detailEnvelope(
    {
      unitKey: input.unitKey,
      planKey: `tcgplayer:proof:${input.detail.productId}`,
      scope: {
        unitKey: input.unitKey,
        scopeKey: "set-name",
        values: {
          productLineName: input.detail.productLineName,
          setName: input.detail.setName,
        },
      },
      estimatedPayloads: 1,
      transportSteps: ["Use fixture-backed TCGplayer product detail proof"],
    },
    input.detail,
    input.fetchedAt,
  );

  return runCatalogIntegrationDryRun({
    unitKey: input.unitKey,
    profileVersion: input.profileVersion,
    payloads: [payload],
    normalize: (envelope) => normalizeTcgplayerMtgProofPayload(envelope, input.profileVersion),
  });
}

function compactStringRecord(values: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function normalizeTcgplayerMtgProofPayload(
  envelope: ProviderPayloadEnvelope<TcgplayerProviderPayload>,
  profileVersion: string,
): CatalogIntegrationObservationFact {
  if (envelope.payload.kind !== "product-detail") {
    throw new Error("TCGplayer Magic proof dry run received a non-detail payload.");
  }

  const detail = envelope.payload.detail;
  return {
    unitKey: envelope.unitKey,
    providerKey: envelope.providerKey,
    externalKey: envelope.externalKey,
    profileVersion,
    normalizedFacts: compactStringRecord({
      productId: String(detail.productId),
      name: detail.productName,
      setCode: detail.setCode,
      setName: detail.setName,
      productLineName: detail.productLineName,
      productTypeName: detail.productTypeName,
      productForm: detail.sealed ? "sealed" : "single",
      cardNumber: detail.customAttributes.number,
      releaseDate: detail.customAttributes.releaseDate,
      skuCount: String(detail.skus.length),
      firstSkuId: detail.skus[0] ? String(detail.skus[0].sku) : undefined,
      firstSkuCondition: detail.skus[0]?.condition,
      firstSkuVariant: detail.skus[0]?.variant,
      firstSkuLanguage: detail.skus[0]?.language,
    }),
    sourceUrl: envelope.provenance.sourceUrl,
    sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
  };
}

const tcgplayerMtgSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Uncommon",
  sealed: false,
  productName: "Fury Sliver",
  setId: 1001,
  setCode: "TSP",
  productId: 14240,
  setName: "Time Spiral",
  productLineId: 1,
  productStatusId: 1,
  productLineName: "Magic",
  customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
  formattedAttributes: { Artist: "Paolo Parente" },
  skus: [{ sku: 50014240, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 1.23,
  lowestPrice: 1.01,
  lowestPriceWithShipping: 1.23,
  medianPrice: 1.5,
  listings: 25,
};

const tcgplayerMtgSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Time Spiral Booster Pack",
  setId: 1001,
  setCode: "TSP",
  productId: 96601,
  setName: "Time Spiral",
  productLineId: 1,
  productStatusId: 1,
  productLineName: "Magic",
  customAttributes: { number: "PACK", releaseDate: "2006-10-06", cardType: ["Sealed"] },
  barcode: "0653569123456",
  formattedAttributes: {},
  skus: [{ sku: 50096601, condition: "Sealed", variant: "Sealed", language: "English" }],
  marketPrice: 12.34,
  lowestPrice: 10.01,
  lowestPriceWithShipping: 11.23,
  medianPrice: 12.5,
  listings: 25,
};

const tcgplayerPokemonSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Common",
  sealed: false,
  productName: "Sprigatito",
  setId: 10001,
  setCode: "SVI",
  productId: 493958,
  setName: "Scarlet & Violet",
  productLineId: 3,
  productStatusId: 1,
  productLineName: "Pokemon",
  customAttributes: { number: "001/198", releaseDate: "2023-03-31", cardType: ["Pokemon"] },
  formattedAttributes: {},
  skus: [{ sku: 15500001, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 0.12,
  lowestPrice: 0.08,
  lowestPriceWithShipping: 1.01,
  medianPrice: 0.19,
  listings: 42,
};

const tcgplayerYugiohSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Ultra Rare",
  sealed: false,
  productName: "Dark Magician",
  setId: 2002,
  setCode: "SDY",
  productId: 17851,
  setName: "Starter Deck: Yugi",
  productLineId: 2,
  productStatusId: 1,
  productLineName: "Yu-Gi-Oh!",
  customAttributes: { number: "SDY-006", releaseDate: "2002-03-29", cardType: ["Normal Monster"] },
  formattedAttributes: {},
  skus: [{ sku: 60017851, condition: "Near Mint", variant: "Unlimited", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerOnePieceSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Leader",
  sealed: false,
  productName: "Monkey.D.Luffy",
  setId: 6801,
  setCode: "OP-01",
  productId: 987650,
  setName: "Romance Dawn",
  productLineId: 68,
  productStatusId: 1,
  productLineName: "One Piece Card Game",
  customAttributes: { number: "OP01-001", releaseDate: "2022-12-02", cardType: ["Leader"] },
  formattedAttributes: {},
  skus: [{ sku: 900987650, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerOnePieceSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Romance Dawn Booster Box",
  setId: 6801,
  setCode: "OP-01",
  productId: 987660,
  setName: "Romance Dawn",
  productLineId: 68,
  productStatusId: 1,
  productLineName: "One Piece Card Game",
  customAttributes: { number: "BOX", releaseDate: "2022-12-02", cardType: ["Sealed"] },
  barcode: "811039041234",
  formattedAttributes: {},
  skus: [{ sku: 900987660, condition: "Sealed", variant: "Sealed", language: "English" }],
};

const tcgplayerLorcanaSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Rare",
  sealed: false,
  productName: "Elsa - Snow Queen",
  setId: 5010,
  setCode: "TFC",
  productId: 1005010,
  setName: "The First Chapter",
  productLineId: 71,
  productStatusId: 1,
  productLineName: "Disney Lorcana",
  customAttributes: { number: "3/204", releaseDate: "2023-08-18", cardType: ["Character"] },
  formattedAttributes: {},
  skus: [{ sku: 91005010, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerLorcanaSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "The First Chapter Booster Box",
  setId: 5010,
  setCode: "TFC",
  productId: 1005020,
  setName: "The First Chapter",
  productLineId: 71,
  productStatusId: 1,
  productLineName: "Disney Lorcana",
  customAttributes: { number: "BOX", releaseDate: "2023-08-18", cardType: ["Sealed"] },
  barcode: "4050368981234",
  formattedAttributes: {},
  skus: [{ sku: 91005020, condition: "Sealed", variant: "Sealed", language: "English" }],
};

const tcgplayerPokemonSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Scarlet & Violet Elite Trainer Box",
  setId: 10001,
  setCode: "SVI",
  productId: 497105,
  setName: "Scarlet & Violet",
  productLineId: 3,
  productStatusId: 1,
  productLineName: "Pokemon",
  customAttributes: { number: "ETB", releaseDate: "2023-03-31", cardType: ["Sealed"] },
  barcode: "0820650851234",
  formattedAttributes: {},
  skus: [{ sku: 15501001, condition: "Sealed", variant: "Sealed", language: "English" }],
};

export type TcgplayerUnitConstraints = Readonly<{
  unitKey: string;
  productLineNames: readonly string[];
  productLineUrlNames: readonly string[];
  defaultProductLineName: string;
  productForm: "single-card" | "sealed-product";
}>;

export type TcgplayerSingleCardUnitConstraints = TcgplayerUnitConstraints &
  Readonly<{
    productDomain: "pokemon" | "magic" | "yugioh" | "one-piece" | "lorcana";
    discoveryLanguageCode: "en";
    productForm: "single-card";
  }>;

export const tcgplayerSingleCardUnitConstraints: readonly TcgplayerSingleCardUnitConstraints[] = Object.freeze([
  {
    unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    productDomain: "magic",
    discoveryLanguageCode: "en",
    productLineNames: ["magic", "magic: the gathering", "magic the gathering", "mtg"],
    productLineUrlNames: ["magic", "magic-the-gathering", "mtg"],
    defaultProductLineName: "Magic",
    productForm: "single-card",
  },
  {
    unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    productDomain: "pokemon",
    discoveryLanguageCode: "en",
    productLineNames: ["pokemon", "pokemon trading card game", "pokemon tcg"],
    productLineUrlNames: ["pokemon", "pokemon-tcg"],
    defaultProductLineName: "Pokemon",
    productForm: "single-card",
  },
  {
    unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    productDomain: "yugioh",
    discoveryLanguageCode: "en",
    productLineNames: ["yu-gi-oh!", "yugioh", "yu-gi-oh", "yu gi oh"],
    productLineUrlNames: ["yugioh", "yu-gi-oh"],
    defaultProductLineName: "Yu-Gi-Oh!",
    productForm: "single-card",
  },
  {
    unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    productDomain: "one-piece",
    discoveryLanguageCode: "en",
    productLineNames: ["one piece card game", "one piece", "onepiece", "opcg"],
    productLineUrlNames: ["one-piece-card-game", "one-piece", "onepiece"],
    defaultProductLineName: "One Piece Card Game",
    productForm: "single-card",
  },
  {
    unitKey: TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    productDomain: "lorcana",
    discoveryLanguageCode: "en",
    productLineNames: ["disney lorcana", "lorcana"],
    productLineUrlNames: ["disney-lorcana", "lorcana"],
    defaultProductLineName: "Disney Lorcana",
    productForm: "single-card",
  },
]);

export function constraintsForTcgplayerUnit(unitKey: string): TcgplayerUnitConstraints {
  const singleCard = tcgplayerSingleCardUnitConstraints.find((constraints) => constraints.unitKey === unitKey);
  if (singleCard) return singleCard;
  if (unitKey === TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["one piece card game", "one piece", "onepiece", "opcg"],
      productLineUrlNames: ["one-piece-card-game", "one-piece", "onepiece"],
      defaultProductLineName: "One Piece Card Game",
      productForm: "sealed-product",
    };
  }
  if (unitKey === TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["disney lorcana", "lorcana"],
      productLineUrlNames: ["disney-lorcana", "lorcana"],
      defaultProductLineName: "Disney Lorcana",
      productForm: "sealed-product",
    };
  }
  if (unitKey === TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["magic", "magic: the gathering", "magic the gathering", "mtg"],
      productLineUrlNames: ["magic", "magic-the-gathering", "mtg"],
      defaultProductLineName: "Magic",
      productForm: "sealed-product",
    };
  }
  if (unitKey === TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["pokemon", "pokemon trading card game", "pokemon tcg"],
      productLineUrlNames: ["pokemon", "pokemon-tcg"],
      defaultProductLineName: "Pokemon",
      productForm: "sealed-product",
    };
  }
  throw new Error(`TCGplayer adapter does not support Catalog integration unit '${unitKey}'.`);
}

import { toJsonValue, type JsonObject, type JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationExternalProductReference } from "../../domain/domain";
import type {
  CatalogProviderExternalReferenceRule,
  CatalogProviderSelectedOptionMapping,
} from "../provider-integration-profiles";
import { extractCatalogProviderExternalReferences } from "../promotion/provider-external-reference-extractor";
import {
  resolveCatalogProviderSelectedOptions,
  type CatalogProviderProductReferenceDimension,
  type CatalogProviderProductReferenceOption,
  type CatalogProviderProductReferenceSchema,
} from "./provider-selected-option-resolver";
import type {
  TcgplayerAutomationDomainHttpClient,
  TcgplayerAutomationHttpClients,
} from "./tcgplayer-automation-client";

export type TcgplayerAutomationProductLine = Readonly<{
  productLineId: number;
  productLineName: string;
  productLineUrlName: string;
  isDirect: boolean;
}>;

export type TcgplayerAutomationCatalogSetName = Readonly<{
  setNameId: number;
  categoryId: number;
  name: string;
  cleanSetName: string;
  urlName: string;
  abbreviation?: string;
  releaseDate?: string;
  isSupplemental: boolean;
  active: boolean;
}>;

export type TcgplayerAutomationCatalogSetNamesResponse = Readonly<{
  errors: readonly JsonValue[];
  results: readonly TcgplayerAutomationCatalogSetName[];
}>;

export type TcgplayerAutomationProductSearchRequest = Readonly<{
  from?: number;
  size?: number;
  filters?: Readonly<{
    term?: Readonly<{
      productLineName?: readonly string[];
      setName?: readonly string[];
    }>;
  }>;
  sort?: Readonly<{
    field: string;
    order: string;
  }>;
}>;

export type TcgplayerAutomationProductSearchResponse = Readonly<{
  errors: readonly JsonValue[];
  results: readonly TcgplayerAutomationProductSearchPage[];
}>;

export type TcgplayerAutomationProductSearchPage = Readonly<{
  results: readonly TcgplayerAutomationProductSearchProduct[];
  totalResults: number;
  resultId: string;
}>;

export type TcgplayerAutomationProductSearchProduct = Readonly<{
  productId: number;
  productName: string;
  productLineId: number;
  productLineName: string;
  productTypeName?: string;
  setId: number;
  setName: string;
  setUrlName: string;
  rarityName: string;
  sealed: boolean;
  productStatusId: number;
  customAttributes: Readonly<{
    number?: string;
    releaseDate?: string;
    cardType?: readonly string[];
  }>;
}>;

export type TcgplayerAutomationProductDetail = Readonly<{
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
    detailNote?: string;
    barcode?: string;
    gtin?: string;
    upc?: string;
    packCount?: number | string;
  }>;
  barcode?: string;
  gtin?: string;
  upc?: string;
  formattedAttributes?: Readonly<{
    Artist?: string;
  }>;
  skus: readonly TcgplayerAutomationProductSku[];
  marketPrice?: number | null;
  lowestPrice?: number | null;
  lowestPriceWithShipping?: number | null;
  medianPrice?: number | null;
  listings?: number | null;
}>;

export type TcgplayerAutomationProductSku = Readonly<{
  sku: number;
  condition: string;
  variant: string;
  language: string;
}>;

export type TcgplayerProductReferenceSchema = CatalogProviderProductReferenceSchema;

export type TcgplayerProductReferenceDimension = CatalogProviderProductReferenceDimension;

export type TcgplayerProductReferenceOption = CatalogProviderProductReferenceOption;

export type TcgplayerAutomationCatalogClient = Readonly<{
  listProductLines: () => Promise<readonly TcgplayerAutomationProductLine[]>;
  listCatalogSetNames: (input: { categoryId: number }) => Promise<TcgplayerAutomationCatalogSetNamesResponse>;
  searchProducts: (input: TcgplayerAutomationProductSearchRequest) => Promise<TcgplayerAutomationProductSearchResponse>;
  listAllProducts: (
    input: Omit<TcgplayerAutomationProductSearchRequest, "from">,
  ) => Promise<readonly TcgplayerAutomationProductSearchProduct[]>;
  getProductDetail: (input: { productId: number }) => Promise<TcgplayerAutomationProductDetail>;
}>;

export function createTcgplayerAutomationCatalogClient(
  clients: Pick<TcgplayerAutomationHttpClients, "mpSearchApi" | "mpApi">,
): TcgplayerAutomationCatalogClient {
  return {
    listProductLines: () => clients.mpSearchApi.get("/v1/search/productLines"),
    listCatalogSetNames: ({ categoryId }) => clients.mpApi.get("/v2/Catalog/SetNames", { categoryId }),
    searchProducts: (input) => clients.mpSearchApi.post("/v1/search/request", input),
    listAllProducts: (input) => listAllTcgplayerAutomationProducts(clients.mpSearchApi, input),
    getProductDetail: ({ productId }) => clients.mpSearchApi.get(`/v2/product/${productId}/details`),
  };
}

export function buildTcgplayerAutomationSourceObservationPayload(input: {
  detail: TcgplayerAutomationProductDetail;
  externalReferenceRules: readonly CatalogProviderExternalReferenceRule[];
  selectedOptionMapping: CatalogProviderSelectedOptionMapping;
  sourceUrl?: string;
  productReferenceSchema?: TcgplayerProductReferenceSchema | null;
}): JsonObject {
  const languageCode = "en";
  const externalKey = `product:${input.detail.productId}`;
  const sourceUrl =
    input.sourceUrl ?? `https://mp-search-api.tcgplayer.com/v2/product/${input.detail.productId}/details`;
  const skuReferences = input.detail.skus.map((sku) => ({
    providerKey: "tcgplayer",
    externalKey: `sku:${sku.sku}`,
    reviewEvidence: skuReviewEvidence(input.detail, sku),
  }));
  const externalReferences = extractTcgplayerAutomationExternalReferences(
    input.detail,
    input.productReferenceSchema ?? null,
    input.selectedOptionMapping,
    input.externalReferenceRules,
  );
  const collectorNumber = tcgplayerCatalogCollectorNumber(input.detail);

  return {
    ...input.detail,
    customAttributes: {
      ...input.detail.customAttributes,
      number: collectorNumber ?? undefined,
    },
    observationId: `tcgplayer_${languageCode}_product_${input.detail.productId}`,
    externalKey,
    sourceUrl,
    sourceUpdatedAt: input.detail.customAttributes.releaseDate ?? null,
    sourcePayload: input.detail as JsonValue,
    catalogHashMaterial: tcgplayerCatalogHashMaterial(input.detail),
    productForm: tcgplayerProductForm(input.detail),
    sealedProductForm: tcgplayerSealedProductForm(input.detail),
    packCount: tcgplayerPackCount(input.detail),
    releaseYear: tcgplayerReleaseYear(input.detail),
    imageUrls: [],
    barcode: tcgplayerProductBarcode(input.detail),
    mergeIdentity: {
      tcg: normalizeTcgName(input.detail.productLineName),
      productLineName: input.detail.productLineName,
      setName: input.detail.setName,
      printedProductName: input.detail.productName,
      collectorNumber,
      languageCode,
      productForm: tcgplayerProductForm(input.detail),
      barcode: tcgplayerProductBarcode(input.detail),
    },
    externalCatalogItemReferences: externalReferences.externalCatalogItemReferences,
    externalProductReferences: externalReferences.externalProductReferences,
    skuReferences,
  };
}

function tcgplayerCatalogCollectorNumber(detail: TcgplayerAutomationProductDetail): string | null {
  const number = detail.customAttributes.number?.trim();
  if (!number) {
    return null;
  }

  if (normalizeTcgName(detail.productLineName) !== "pokemon") {
    return number;
  }

  return number.replace(/\/\d+$/u, "").trim();
}

export function mapTcgplayerSkuExternalProductReferences(
  detail: TcgplayerAutomationProductDetail,
  schema: TcgplayerProductReferenceSchema,
  selectedOptionMapping: CatalogProviderSelectedOptionMapping,
  externalReferenceRules: readonly CatalogProviderExternalReferenceRule[],
): readonly SourceObservationExternalProductReference[] {
  return extractTcgplayerAutomationExternalReferences(detail, schema, selectedOptionMapping, externalReferenceRules)
    .externalProductReferences;
}

function extractTcgplayerAutomationExternalReferences(
  detail: TcgplayerAutomationProductDetail,
  schema: TcgplayerProductReferenceSchema | null,
  selectedOptionMapping: CatalogProviderSelectedOptionMapping,
  externalReferenceRules: readonly CatalogProviderExternalReferenceRule[],
) {
  const skus = detail.skus.map((sku) => {
    const selectedOptionResult = schema
      ? resolveCatalogProviderSelectedOptions({
          mapping: selectedOptionMapping,
          payload: toJsonValue(detail),
          record: toJsonValue(sku),
          productReferenceSchema: schema,
        })
      : null;
    return {
      ...sku,
      selectedOptions: selectedOptionResult?.resolved ? selectedOptionResult.selectedOptions : undefined,
      reviewEvidence: skuReviewEvidence(detail, sku, selectedOptionResult ?? undefined),
    };
  });

  return extractCatalogProviderExternalReferences({
    rules: externalReferenceRules,
    payload: {
      ...detail,
      skus,
    },
  });
}

export function tcgplayerCatalogHashMaterial(detail: TcgplayerAutomationProductDetail): JsonObject {
  return {
    productId: detail.productId,
    productName: detail.productName,
    productLineId: detail.productLineId,
    productLineName: detail.productLineName,
    productTypeName: detail.productTypeName,
    setId: detail.setId,
    setCode: detail.setCode,
    setName: detail.setName,
    rarityName: detail.rarityName,
    sealed: detail.sealed,
    productForm: tcgplayerProductForm(detail),
    sealedProductForm: tcgplayerSealedProductForm(detail),
    packCount: tcgplayerPackCount(detail),
    barcode: tcgplayerProductBarcode(detail),
    productStatusId: detail.productStatusId,
    number: detail.customAttributes.number,
    releaseDate: detail.customAttributes.releaseDate,
    releaseYear: tcgplayerReleaseYear(detail),
    cardType: detail.customAttributes.cardType ? [...detail.customAttributes.cardType] : undefined,
    artist: detail.formattedAttributes?.Artist,
    skus: detail.skus.map((sku) => ({
      sku: sku.sku,
      condition: sku.condition,
      variant: sku.variant,
      language: sku.language,
    })),
  };
}

function tcgplayerProductForm(detail: Pick<TcgplayerAutomationProductDetail, "sealed">): "sealed" | "single" {
  return detail.sealed ? "sealed" : "single";
}

function tcgplayerSealedProductForm(
  detail: Pick<TcgplayerAutomationProductDetail, "sealed" | "productName" | "productTypeName">,
): "booster-pack" | "booster-box" | "bundle" | "deck" | "sealed-product" | null {
  if (!detail.sealed) {
    return null;
  }
  const normalized = `${detail.productTypeName} ${detail.productName}`.trim().toLowerCase();
  if (normalized.includes("booster box")) {
    return "booster-box";
  }
  if (normalized.includes("booster pack") || normalized.includes(" pack")) {
    return "booster-pack";
  }
  if (normalized.includes("bundle")) {
    return "bundle";
  }
  if (normalized.includes("deck")) {
    return "deck";
  }
  return "sealed-product";
}

function tcgplayerPackCount(detail: TcgplayerAutomationProductDetail): number | null {
  if (!detail.sealed) {
    return null;
  }
  const explicitPackCount = parsePositiveInteger(detail.customAttributes.packCount);
  if (explicitPackCount !== null) {
    return explicitPackCount;
  }

  const normalized = `${detail.productTypeName} ${detail.productName}`.trim().toLowerCase();
  const packCountMatch = normalized.match(/\b(\d+)\s*(?:count|ct|pack|packs)\b/);
  if (packCountMatch?.[1]) {
    return Number(packCountMatch[1]);
  }
  if (normalized.includes("booster box")) {
    return 36;
  }
  return 1;
}

function tcgplayerReleaseYear(detail: TcgplayerAutomationProductDetail): number | null {
  const releaseDate = detail.customAttributes.releaseDate?.trim();
  const year = releaseDate?.match(/^(\d{4})/)?.[1];
  return year ? Number(year) : null;
}

function tcgplayerProductBarcode(detail: TcgplayerAutomationProductDetail): string | null {
  return firstNonEmptyString(
    detail.gtin,
    detail.upc,
    detail.barcode,
    detail.customAttributes.gtin,
    detail.customAttributes.upc,
    detail.customAttributes.barcode,
  );
}

function firstNonEmptyString(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function parsePositiveInteger(value: string | number | null | undefined): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = Number(String(value).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function listAllTcgplayerAutomationProducts(
  client: TcgplayerAutomationDomainHttpClient,
  input: Omit<TcgplayerAutomationProductSearchRequest, "from">,
): Promise<readonly TcgplayerAutomationProductSearchProduct[]> {
  const size = Math.min(input.size ?? 24, 24);
  const products: TcgplayerAutomationProductSearchProduct[] = [];
  let total = 0;
  let from = 0;

  do {
    const response = await client.post<TcgplayerAutomationProductSearchResponse>("/v1/search/request", {
      ...input,
      from,
      size,
    });
    const page = response.results[0];
    if (!page) {
      return products;
    }
    if (from === 0) {
      total = page.totalResults;
    }
    products.push(...page.results);
    from += size;
  } while (products.length < total);

  return products;
}

function skuReviewEvidence(
  detail: TcgplayerAutomationProductDetail,
  sku: TcgplayerAutomationProductSku,
  selectedOptionResult?: ReturnType<typeof resolveCatalogProviderSelectedOptions>,
): JsonObject {
  const reviewEvidence: JsonObject = {
    condition: sku.condition,
    printing: sku.variant,
    language: sku.language,
    productForm: detail.sealed ? "unopened" : "single",
  };

  if (selectedOptionResult && !selectedOptionResult.resolved && selectedOptionResult.reviewEvidence.length > 0) {
    reviewEvidence.selectedOptions = toJsonValue(selectedOptionResult.reviewEvidence);
  }

  return reviewEvidence;
}

function normalizeTcgName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pokemon" || normalized === "pokemon tcg" || normalized === "pokemon trading card game") {
    return "pokemon";
  }
  if (normalized === "magic" || normalized === "mtg" || normalized === "magic: the gathering") {
    return "magic";
  }
  return normalized;
}

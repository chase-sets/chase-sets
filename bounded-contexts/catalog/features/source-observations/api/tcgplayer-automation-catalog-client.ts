import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  SourceObservationExternalProductReference,
  SourceObservationProviderProductNormalized,
  SourceObservationSelectedOptionReference,
} from "../domain/domain";
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
  }>;
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

export type TcgplayerAutomationSourceObservationInput = Readonly<{
  observationId: string;
  providerKey: "tcgplayer";
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  normalized: SourceObservationProviderProductNormalized;
  sourcePayload: JsonValue;
}>;

export type TcgplayerProductReferenceDimensionKey = "condition" | "printing" | "language" | "product-form";

export type TcgplayerProductReferenceSchema = Readonly<{
  dimensions: readonly TcgplayerProductReferenceDimension[];
}>;

export type TcgplayerProductReferenceDimension = Readonly<{
  dimensionKey: TcgplayerProductReferenceDimensionKey;
  dimensionId: string;
  required?: boolean;
  options: readonly TcgplayerProductReferenceOption[];
}>;

export type TcgplayerProductReferenceOption = Readonly<{
  optionId: string;
  aliases: readonly string[];
}>;

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

export function toTcgplayerAutomationSourceObservation(input: {
  detail: TcgplayerAutomationProductDetail;
  observedAt: string;
  sourceUrl?: string;
  productReferenceSchema?: TcgplayerProductReferenceSchema | null;
}): TcgplayerAutomationSourceObservationInput {
  const languageCode = "en";
  const externalKey = `product:${input.detail.productId}`;
  const skuReferences = input.detail.skus.map((sku) => ({
    providerKey: "tcgplayer",
    externalKey: `sku:${sku.sku}`,
    reviewEvidence: skuReviewEvidence(input.detail, sku),
  }));
  const normalized: SourceObservationProviderProductNormalized = {
    kind: "provider-product",
    languageCode,
    name: input.detail.productName,
    setName: input.detail.setName,
    expansionName: input.detail.setName,
    cardNumber: input.detail.customAttributes.number ?? null,
    imageUrls: [],
    mergeIdentity: {
      tcg: normalizeTcgName(input.detail.productLineName),
      productLineName: input.detail.productLineName,
      setName: input.detail.setName,
      printedProductName: input.detail.productName,
      collectorNumber: input.detail.customAttributes.number ?? null,
      languageCode,
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey }],
    externalProductReferences: input.productReferenceSchema
      ? mapTcgplayerSkuExternalProductReferences(input.detail, input.productReferenceSchema)
      : [],
    providerProductId: String(input.detail.productId),
    providerProductName: input.detail.productName,
    productLineName: input.detail.productLineName,
    productCategoryName: input.detail.productTypeName,
    skuReferences,
  };

  return {
    observationId: `tcgplayer_${languageCode}_product_${input.detail.productId}`,
    providerKey: "tcgplayer",
    externalKey,
    sourceUrl: input.sourceUrl ?? `https://mp-search-api.tcgplayer.com/v2/product/${input.detail.productId}/details`,
    languageCode,
    sourceRecordHash: hashJson(tcgplayerCatalogHashMaterial(input.detail)),
    sourceUpdatedAt: input.detail.customAttributes.releaseDate ?? null,
    observedAt: input.observedAt,
    normalized,
    sourcePayload: input.detail as JsonValue,
  };
}

export function mapTcgplayerSkuExternalProductReferences(
  detail: TcgplayerAutomationProductDetail,
  schema: TcgplayerProductReferenceSchema,
): readonly SourceObservationExternalProductReference[] {
  return detail.skus.flatMap((sku) => {
    const selectedOptions = resolveTcgplayerSkuSelectedOptions(detail, sku, schema);
    return selectedOptions
      ? [
          {
            providerKey: "tcgplayer",
            externalKey: `sku:${sku.sku}`,
            selectedOptions,
            reviewEvidence: skuReviewEvidence(detail, sku),
          },
        ]
      : [];
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
    productStatusId: detail.productStatusId,
    number: detail.customAttributes.number,
    releaseDate: detail.customAttributes.releaseDate,
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

function resolveTcgplayerSkuSelectedOptions(
  detail: TcgplayerAutomationProductDetail,
  sku: TcgplayerAutomationProductSku,
  schema: TcgplayerProductReferenceSchema,
): readonly SourceObservationSelectedOptionReference[] | null {
  const selectedOptions: SourceObservationSelectedOptionReference[] = [];

  for (const dimension of schema.dimensions) {
    const providerValue = providerValueForDimension(detail, sku, dimension.dimensionKey);
    if (!providerValue) {
      if (dimension.required) {
        return null;
      }
      continue;
    }

    const option = dimension.options.find((candidate) =>
      candidate.aliases.some((alias) => normalizeProviderOption(alias) === normalizeProviderOption(providerValue)),
    );
    if (!option) {
      return null;
    }
    selectedOptions.push({
      dimensionId: dimension.dimensionId,
      optionId: option.optionId,
    });
  }

  return selectedOptions.length > 0
    ? selectedOptions.sort((left, right) =>
        left.dimensionId === right.dimensionId
          ? left.optionId.localeCompare(right.optionId)
          : left.dimensionId.localeCompare(right.dimensionId),
      )
    : null;
}

function providerValueForDimension(
  detail: TcgplayerAutomationProductDetail,
  sku: TcgplayerAutomationProductSku,
  dimensionKey: TcgplayerProductReferenceDimensionKey,
): string | null {
  switch (dimensionKey) {
    case "condition":
      return sku.condition;
    case "printing":
      return sku.variant;
    case "language":
      return sku.language;
    case "product-form":
      return detail.sealed ? "unopened" : "single";
  }
}

function skuReviewEvidence(detail: TcgplayerAutomationProductDetail, sku: TcgplayerAutomationProductSku): JsonObject {
  return {
    condition: sku.condition,
    printing: sku.variant,
    language: sku.language,
    productForm: detail.sealed ? "unopened" : "single",
  };
}

function normalizeProviderOption(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeTcgName(value: string): string {
  return value.trim().toLowerCase() === "pokemon" ? "pokemon" : value.trim().toLowerCase();
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

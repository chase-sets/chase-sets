import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationProviderProductNormalized } from "../domain/domain";
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
}): TcgplayerAutomationSourceObservationInput {
  const languageCode = "en";
  const externalKey = `product:${input.detail.productId}`;
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
    externalProductReferences: input.detail.skus.map((sku) => ({
      providerKey: "tcgplayer",
      externalKey: `sku:${sku.sku}`,
      selectedOptions: skuSelectedOptions(input.detail, sku),
    })),
    providerProductId: String(input.detail.productId),
    providerProductName: input.detail.productName,
    productLineName: input.detail.productLineName,
    productCategoryName: input.detail.productTypeName,
    skuReferences: input.detail.skus.map((sku) => ({
      providerKey: "tcgplayer",
      externalKey: `sku:${sku.sku}`,
      selectedOptions: skuSelectedOptions(input.detail, sku),
    })),
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

function skuSelectedOptions(detail: TcgplayerAutomationProductDetail, sku: TcgplayerAutomationProductSku): JsonObject {
  return {
    condition: sku.condition,
    printing: sku.variant,
    language: sku.language,
    productForm: detail.sealed ? "unopened" : "single",
  };
}

function normalizeTcgName(value: string): string {
  return value.trim().toLowerCase() === "pokemon" ? "pokemon" : value.trim().toLowerCase();
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  SourceObservationExternalProductReference,
  SourceObservationProviderProductNormalized,
  SourceObservationSelectedOptionReference,
} from "../domain/domain";
import type {
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";
import { tcgplayerAutomationClientProviderProfile } from "./provider-integration-profiles";
import {
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import { extractCatalogProviderExternalReferences } from "./provider-external-reference-extractor";
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
  );
  const normalized = requireCatalogProviderSourceObservation({
    contract: tcgplayerProviderProductSourceObservationMapping,
    observedAt: input.observedAt,
    payload: {
      ...input.detail,
      observationId: `tcgplayer_${languageCode}_product_${input.detail.productId}`,
      externalKey,
      sourceUrl,
      sourceUpdatedAt: input.detail.customAttributes.releaseDate ?? null,
      sourcePayload: input.detail as JsonValue,
      catalogHashMaterial: tcgplayerCatalogHashMaterial(input.detail),
      productForm: tcgplayerProductForm(input.detail),
      barcode: tcgplayerProductBarcode(input.detail),
      mergeIdentity: {
        tcg: normalizeTcgName(input.detail.productLineName),
        productLineName: input.detail.productLineName,
        setName: input.detail.setName,
        printedProductName: input.detail.productName,
        collectorNumber: input.detail.customAttributes.number ?? null,
        languageCode,
        productForm: tcgplayerProductForm(input.detail),
        barcode: tcgplayerProductBarcode(input.detail),
      },
      externalCatalogItemReferences: externalReferences.externalCatalogItemReferences,
      externalProductReferences: externalReferences.externalProductReferences,
      skuReferences,
    },
  });

  return {
    ...normalized,
    providerKey: "tcgplayer",
    normalized: normalized.normalized as SourceObservationProviderProductNormalized,
  };
}

const tcgplayerProviderProductSourceObservationMapping = {
  providerKey: "tcgplayer",
  profileKey: "pokemon-tcg-automation-client",
  displayName: "TCGplayer Provider Product",
  profileVersion: "2026.06.03",
  lifecycle: "test",
  sourceContract: {
    owner: "Catalog",
    repository: "todd-skelton/tcgplayer-automation-app",
    commit: "bf42aa8",
    documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    fixtureSetVersion: "automation-client-contract-v1",
  },
  connector: {
    kind: "tcgplayer-automation-client",
    transportOwns: ["auth", "domains", "endpoint-paths", "pagination", "throttling", "raw-provider-parse"],
    mappingOwns: ["source-payload", "normalized-observation", "hash-material", "merge-identity", "external-reference"],
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-automation",
    coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
    liveProviderCallsAllowed: false,
  },
  sourceObservation: {
    observationId: pathExpression("observationId", "catalog-merge-evidence", ["normalized-observation"]),
    externalKey: pathExpression("externalKey", "external-reference", ["external-reference"]),
    sourceUrl: pathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: optionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
    sourcePayload: pathExpression("sourcePayload", "catalog-merge-evidence", ["source-payload"]),
  },
  normalizedObservation: {
    outputKind: "provider-product",
    languageCode: constantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      name: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber: optionalPathExpression("customAttributes.number", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      imageUrls: constantExpression([], "catalog-truth", ["normalized-observation"]),
      mergeIdentity: pathExpression("mergeIdentity", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      externalCatalogItemReferences: pathExpression("externalCatalogItemReferences", "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: pathExpression("externalProductReferences", "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      providerProductId: pathExpression(
        "productId",
        "external-reference",
        ["normalized-observation", "hash-material"],
        {
          transforms: [{ kind: "coerce", to: "string" }],
        },
      ),
      providerProductName: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: pathExpression("productLineName", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      productCategoryName: pathExpression("productTypeName", "catalog-merge-evidence", ["normalized-observation"]),
      skuReferences: pathExpression("skuReferences", "external-reference", ["normalized-observation"]),
    },
    hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
    mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
  },
  externalReferences: [],
  referenceHierarchy: [],
  duplicatePrevention: {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  },
  promotionCommandPlan: {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  },
  nonGoals: [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ],
} as const satisfies CatalogProviderSourceObservationMappingContract;

function pathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function optionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "allow-null",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function constantExpression(
  value: JsonValue,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "constant",
      value,
    },
    owner,
    uses,
    redaction: "none",
  };
}

export function mapTcgplayerSkuExternalProductReferences(
  detail: TcgplayerAutomationProductDetail,
  schema: TcgplayerProductReferenceSchema,
): readonly SourceObservationExternalProductReference[] {
  return extractTcgplayerAutomationExternalReferences(detail, schema).externalProductReferences;
}

function extractTcgplayerAutomationExternalReferences(
  detail: TcgplayerAutomationProductDetail,
  schema: TcgplayerProductReferenceSchema | null,
) {
  const skus = detail.skus.map((sku) => {
    const selectedOptions = schema ? resolveTcgplayerSkuSelectedOptions(detail, sku, schema) : null;
    return {
      ...sku,
      selectedOptions: selectedOptions ?? undefined,
      reviewEvidence: skuReviewEvidence(detail, sku),
    };
  });

  return extractCatalogProviderExternalReferences({
    rules: tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules,
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
    barcode: tcgplayerProductBarcode(detail),
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

function tcgplayerProductForm(detail: Pick<TcgplayerAutomationProductDetail, "sealed">): "sealed" | "single" {
  return detail.sealed ? "sealed" : "single";
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

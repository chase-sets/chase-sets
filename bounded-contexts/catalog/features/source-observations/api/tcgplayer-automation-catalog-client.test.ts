import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  createTcgplayerAutomationCatalogClient,
  mapTcgplayerSkuExternalProductReferences,
  tcgplayerCatalogHashMaterial,
  type TcgplayerAutomationProductDetail,
  type TcgplayerAutomationProductSearchResponse,
  type TcgplayerProductReferenceSchema,
} from "./tcgplayer-automation-catalog-client";
import {
  requireCatalogProviderSourceObservationMappingContract,
  tcgplayerAutomationClientProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
} from "./provider-integration-profiles";
import {
  tcgplayerMtgSealedProductSourceObservationMappingContract,
  tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
} from "./tcgplayer-executable-mapping-contract";
import { requireCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { tcgplayerAutomationResponseFixtures } from "./tcgplayer-automation-response-fixtures.test-data";

describe("TCGplayer automation Catalog client", () => {
  it("uses automation-app endpoint paths for product lines, set names, search, and product details", async () => {
    const mpSearchApi = {
      get: vi.fn(async (path: string) =>
        path.includes("productLines")
          ? tcgplayerAutomationResponseFixtures.productLines
          : tcgplayerAutomationResponseFixtures.productDetail,
      ),
      post: vi.fn(async () => tcgplayerAutomationResponseFixtures.productSearch),
    };
    const mpApi = {
      get: vi.fn(async () => tcgplayerAutomationResponseFixtures.catalogSetNames),
    };
    const client = createTcgplayerAutomationCatalogClient({ mpSearchApi, mpApi } as never);

    await client.listProductLines();
    await client.listCatalogSetNames({ categoryId: 3 });
    await client.searchProducts({ size: 24 });
    await client.getProductDetail({ productId: 610001 });

    expect(mpSearchApi.get).toHaveBeenCalledWith("/v1/search/productLines");
    expect(mpApi.get).toHaveBeenCalledWith("/v2/Catalog/SetNames", { categoryId: 3 });
    expect(mpSearchApi.post).toHaveBeenCalledWith("/v1/search/request", { size: 24 });
    expect(mpSearchApi.get).toHaveBeenCalledWith("/v2/product/610001/details");
  });

  it("pages product search with the automation-app page size cap", async () => {
    const pages: TcgplayerAutomationProductSearchResponse[] = [
      searchResponse({ totalResults: 2, productId: 610001 }),
      searchResponse({ totalResults: 2, productId: 610002 }),
    ];
    const mpSearchApi = {
      get: vi.fn(),
      post: vi.fn(async () => pages.shift() ?? searchResponse({ totalResults: 2, productId: 610099 })),
    };
    const client = createTcgplayerAutomationCatalogClient({
      mpSearchApi,
      mpApi: { get: vi.fn() },
    } as never);

    const products = await client.listAllProducts({
      size: 100,
      filters: { term: { setName: ["Prismatic Evolutions"] } },
    });

    expect(products.map((product) => product.productId)).toEqual([610001, 610002]);
    expect(mpSearchApi.post).toHaveBeenNthCalledWith(1, "/v1/search/request", {
      size: 24,
      from: 0,
      filters: { term: { setName: ["Prismatic Evolutions"] } },
    });
    expect(mpSearchApi.post).toHaveBeenNthCalledWith(2, "/v1/search/request", {
      size: 24,
      from: 24,
      filters: { term: { setName: ["Prismatic Evolutions"] } },
    });
  });

  it("normalizes product detail into one provider-product Source Observation with Product and SKU references", () => {
    const observation = normalizeAutomationDetail({
      detail: tcgplayerAutomationResponseFixtures.productDetail,
      observedAt: "2026-06-02T00:00:00.000Z",
    });

    expect(observation).toMatchObject({
      observationId: "tcgplayer_en_product_610001",
      providerKey: "tcgplayer",
      externalKey: "product:610001",
      languageCode: "en",
      normalized: {
        kind: "provider-product",
        providerProductId: "610001",
        providerProductName: "Eevee ex",
        productLineName: "Pokemon",
        productCategoryName: "Cards",
        mergeIdentity: {
          tcg: "pokemon",
          productLineName: "Pokemon",
          setName: "Prismatic Evolutions",
          printedProductName: "Eevee ex",
          collectorNumber: "167/131",
          languageCode: "en",
          productForm: "single",
          barcode: null,
        },
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
        externalProductReferences: [],
        skuReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:7001001",
            reviewEvidence: {
              condition: "Near Mint",
              printing: "Holofoil",
              language: "English",
              productForm: "single",
            },
          },
          {
            providerKey: "tcgplayer",
            externalKey: "sku:7001002",
            reviewEvidence: {
              condition: "Lightly Played",
              printing: "Holofoil",
              language: "English",
              productForm: "single",
            },
          },
        ],
      },
    });
    expect(observation.normalized.externalCatalogItemReferences).not.toContainEqual(
      expect.objectContaining({ externalKey: "sku:7001001" }),
    );
    expect(observation.normalized.externalProductReferences).not.toContainEqual(
      expect.objectContaining({ externalKey: "product:610001" }),
    );
  });

  it("carries sealed-product merge evidence without treating it as single-card identity", () => {
    const sealedDetail: TcgplayerAutomationProductDetail = {
      ...tcgplayerAutomationResponseFixtures.productDetail,
      productId: 610777,
      productName: "Prismatic Evolutions Booster Box",
      productTypeName: "Booster Box",
      rarityName: "",
      sealed: true,
      customAttributes: {
        ...tcgplayerAutomationResponseFixtures.productDetail.customAttributes,
        number: undefined,
        barcode: "0084123456789",
      },
      skus: [],
    };

    const observation = normalizeAutomationDetail({
      detail: sealedDetail,
      observedAt: "2026-06-02T00:00:00.000Z",
    });

    expect(observation.normalized).toMatchObject({
      kind: "provider-product",
      providerProductId: "610777",
      name: "Prismatic Evolutions Booster Box",
      cardNumber: null,
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Prismatic Evolutions",
        printedProductName: "Prismatic Evolutions Booster Box",
        collectorNumber: null,
        languageCode: "en",
        productForm: "sealed",
        barcode: "0084123456789",
      },
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610777" }],
    });
    expect(tcgplayerCatalogHashMaterial(sealedDetail)).toMatchObject({
      productId: 610777,
      productForm: "sealed",
      barcode: "0084123456789",
    });
  });

  it("maps only SKU references whose selected options validate against the Product schema", () => {
    const references = mapTcgplayerSkuExternalProductReferences(
      tcgplayerAutomationResponseFixtures.productDetail,
      rawPokemonSingleProductReferenceSchema(),
      tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules,
    );

    expect(references).toEqual([
      {
        providerKey: "tcgplayer",
        externalKey: "sku:7001001",
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
          },
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
        ],
        reviewEvidence: {
          condition: "Near Mint",
          printing: "Holofoil",
          language: "English",
          productForm: "single",
        },
      },
    ]);
  });

  it("blocks SKU Product references when a schema dimension has unknown provider evidence", () => {
    const references = mapTcgplayerSkuExternalProductReferences(
      tcgplayerAutomationResponseFixtures.productDetail,
      {
        dimensions: [
          ...rawPokemonSingleProductReferenceSchema().dimensions,
          {
            dimensionKey: "printing",
            dimensionId: "dim_printing",
            required: true,
            options: [{ optionId: "opt_reverse_holo", aliases: ["Reverse Holofoil"] }],
          },
        ],
      },
      tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules,
    );

    expect(references).toEqual([]);
  });

  it("can include validated SKU Product references in a Source Observation when a schema is supplied", () => {
    const observation = normalizeAutomationDetail({
      detail: tcgplayerAutomationResponseFixtures.productDetail,
      observedAt: "2026-06-02T00:00:00.000Z",
      productReferenceSchema: rawPokemonSingleProductReferenceSchema(),
    });

    expect(observation.normalized.externalProductReferences).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        externalKey: "sku:7001001",
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
          },
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
        ],
      }),
    ]);
  });

  it("normalizes Magic product details through the Magic single-card profile without Pokemon printing assumptions", () => {
    const magicDetail: TcgplayerAutomationProductDetail = {
      ...tcgplayerAutomationResponseFixtures.productDetail,
      productId: 14240,
      productName: "Fury Sliver",
      productLineId: 1,
      productLineName: "Magic",
      productTypeName: "Cards",
      rarityName: "Uncommon",
      setId: 1001,
      setCode: "TSP",
      setName: "Time Spiral",
      customAttributes: {
        number: "157",
        releaseDate: "2006-10-06",
        cardType: ["Creature"],
      },
      formattedAttributes: {
        Artist: "Paolo Parente",
      },
      skus: [
        {
          sku: 50014240,
          condition: "Near Mint",
          variant: "Foil",
          language: "English",
        },
      ],
    };

    const observation = requireCatalogProviderSourceObservation({
      contract: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
      payload: buildTcgplayerAutomationSourceObservationPayload({
        detail: magicDetail,
        selectedOptionMapping: tcgplayerMtgSingleCardProviderProfile.selectedOptionMapping,
        externalReferenceRules: tcgplayerMtgSingleCardProviderProfile.externalReferenceExtractionRules.rules,
      }),
      observedAt: "2026-06-02T00:00:00.000Z",
    });

    expect(observation.normalized).toMatchObject({
      kind: "provider-product",
      tcg: "magic",
      providerProductId: "14240",
      providerProductName: "Fury Sliver",
      productLineName: "Magic",
      mergeIdentity: {
        tcg: "magic",
        productLineName: "Magic",
        setName: "Time Spiral",
        collectorNumber: "157",
        productForm: "single",
      },
      skuReferences: [
        expect.objectContaining({
          externalKey: "sku:50014240",
          reviewEvidence: expect.objectContaining({ printing: "Foil" }),
        }),
      ],
    });
    expect(
      tcgplayerMtgSingleCardProviderProfile.selectedOptionMapping?.dimensions.find(
        (dimension) => dimension.dimensionKey === "printing",
      )?.valueSynonyms,
    ).toEqual([
      { optionKey: "normal", providerValues: ["Normal", "Standard", "Nonfoil", "Non-Foil"] },
      { optionKey: "foil", providerValues: ["Foil", "Holofoil"] },
    ]);
  });

  it("normalizes Magic sealed products through the sealed profile with pack metadata", () => {
    const sealedDetail: TcgplayerAutomationProductDetail = {
      ...tcgplayerAutomationResponseFixtures.productDetail,
      productId: 96601,
      productName: "Time Spiral Booster Pack",
      productLineId: 1,
      productLineName: "Magic",
      productTypeName: "Sealed Products",
      rarityName: "Sealed",
      sealed: true,
      setId: 1001,
      setCode: "TSP",
      setName: "Time Spiral",
      customAttributes: {
        number: "PACK",
        releaseDate: "2006-10-06",
        barcode: "0653569123456",
      },
      formattedAttributes: {},
      skus: [
        {
          sku: 50096601,
          condition: "Sealed",
          variant: "Sealed",
          language: "English",
        },
      ],
    };

    const payload = buildTcgplayerAutomationSourceObservationPayload({
      detail: sealedDetail,
      selectedOptionMapping: tcgplayerMtgSealedProductProviderProfile.selectedOptionMapping,
      externalReferenceRules: tcgplayerMtgSealedProductProviderProfile.externalReferenceExtractionRules.rules,
    });
    const observation = requireCatalogProviderSourceObservation({
      contract: tcgplayerMtgSealedProductSourceObservationMappingContract,
      payload,
      observedAt: "2026-06-02T00:00:00.000Z",
    });

    expect(observation.normalized).toMatchObject({
      kind: "magic-sealed-product",
      tcg: "magic",
      name: "Time Spiral Booster Pack",
      setCode: "tsp",
      setName: "Time Spiral",
      setId: "1001",
      sealedProductForm: "booster-pack",
      packCount: 1,
      releaseDate: "2006-10-06",
      releaseYear: 2006,
      productLineName: "Magic: The Gathering",
      barcode: "0653569123456",
      imageUrls: [],
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
    });
    expect(payload).toMatchObject({
      sealedProductForm: "booster-pack",
      packCount: 1,
      releaseYear: 2006,
      catalogHashMaterial: expect.objectContaining({
        sealedProductForm: "booster-pack",
        packCount: 1,
      }),
    });
    expect(JSON.stringify(payload.catalogHashMaterial)).not.toMatch(/marketPrice|lowestPrice|listing|seller/i);
  });

  it("excludes price and listing fields from the Catalog observation hash material", () => {
    const detail = tcgplayerAutomationResponseFixtures.productDetail;
    const repriced: TcgplayerAutomationProductDetail = {
      ...detail,
      marketPrice: 10_000,
      lowestPrice: 9_999,
      lowestPriceWithShipping: 10_010,
      medianPrice: 10_001,
      listings: 999,
    };

    expect(tcgplayerCatalogHashMaterial(repriced)).toEqual(tcgplayerCatalogHashMaterial(detail));
    expect(
      normalizeAutomationDetail({
        detail: repriced,
        observedAt: "2026-06-02T00:00:00.000Z",
      }).sourceRecordHash,
    ).toBe(
      normalizeAutomationDetail({
        detail,
        observedAt: "2026-06-02T00:00:00.000Z",
      }).sourceRecordHash,
    );
  });
});

function searchResponse(input: { totalResults: number; productId: number }): TcgplayerAutomationProductSearchResponse {
  return {
    errors: [],
    results: [
      {
        results: [
          {
            ...tcgplayerAutomationResponseFixtures.productSearch.results[0].results[0],
            productId: input.productId,
          },
        ],
        totalResults: input.totalResults,
        resultId: `result-${input.productId}`,
      },
    ],
  };
}

function normalizeAutomationDetail(input: {
  detail: TcgplayerAutomationProductDetail;
  observedAt: string;
  productReferenceSchema?: TcgplayerProductReferenceSchema | null;
}) {
  return requireCatalogProviderSourceObservation({
    contract: requireCatalogProviderSourceObservationMappingContract("tcgplayer", "2026.06.05"),
    payload: buildTcgplayerAutomationSourceObservationPayload({
      ...input,
      selectedOptionMapping: tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      externalReferenceRules: tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules,
    }),
    observedAt: input.observedAt,
  });
}

function rawPokemonSingleProductReferenceSchema(): TcgplayerProductReferenceSchema {
  return {
    dimensions: [
      {
        dimensionKey: "condition",
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        required: true,
        options: [
          { optionId: catalogSeedIds.dimensions.condition.optionIds.pristine, aliases: ["Pristine"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.mint, aliases: ["Mint"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint, aliases: ["Near Mint", "Near-Mint"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.excellent, aliases: ["Excellent"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.good, aliases: ["Good"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.poor, aliases: ["Poor"] },
          { optionId: catalogSeedIds.dimensions.condition.optionIds.damaged, aliases: ["Damaged"] },
        ],
      },
      {
        dimensionKey: "product-form",
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        required: true,
        options: [{ optionId: catalogSeedIds.dimensions.form.optionIds.raw, aliases: ["single", "raw"] }],
      },
    ],
  };
}

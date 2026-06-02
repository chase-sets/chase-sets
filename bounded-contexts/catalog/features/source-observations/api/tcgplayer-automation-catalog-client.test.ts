import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import {
  createTcgplayerAutomationCatalogClient,
  mapTcgplayerSkuExternalProductReferences,
  tcgplayerCatalogHashMaterial,
  toTcgplayerAutomationSourceObservation,
  type TcgplayerAutomationProductDetail,
  type TcgplayerAutomationProductSearchResponse,
  type TcgplayerProductReferenceSchema,
} from "./tcgplayer-automation-catalog-client";
import { tcgplayerAutomationResponseFixtures } from "./tcgplayer-automation-response-fixtures";

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
    const observation = toTcgplayerAutomationSourceObservation({
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

  it("maps only SKU references whose selected options validate against the Product schema", () => {
    const references = mapTcgplayerSkuExternalProductReferences(
      tcgplayerAutomationResponseFixtures.productDetail,
      rawPokemonSingleProductReferenceSchema(),
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
    const references = mapTcgplayerSkuExternalProductReferences(tcgplayerAutomationResponseFixtures.productDetail, {
      dimensions: [
        ...rawPokemonSingleProductReferenceSchema().dimensions,
        {
          dimensionKey: "printing",
          dimensionId: "dim_printing",
          required: true,
          options: [{ optionId: "opt_reverse_holo", aliases: ["Reverse Holofoil"] }],
        },
      ],
    });

    expect(references).toEqual([]);
  });

  it("can include validated SKU Product references in a Source Observation when a schema is supplied", () => {
    const observation = toTcgplayerAutomationSourceObservation({
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
      toTcgplayerAutomationSourceObservation({
        detail: repriced,
        observedAt: "2026-06-02T00:00:00.000Z",
      }).sourceRecordHash,
    ).toBe(
      toTcgplayerAutomationSourceObservation({
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

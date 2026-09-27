import { describe, expect, it } from "vitest";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import { createTcgplayerMarketClient } from "../integrations/tcgplayer/market-client";
import { decodeLatestSales } from "../integrations/tcgplayer/response-decoders";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";
import { expectSourceMutantRed } from "./source-mutant-test-support";

const sale = {
  condition: "Near Mint",
  variant: "Normal",
  language: "English",
  quantity: 1,
  title: "synthetic",
  listingType: "ListingWithPhotos",
  customListingId: "C12_CUSTOM_LISTING_ID_SECRET",
  purchasePrice: 5,
  shippingPrice: 0,
  orderDate: "2026-09-01T00:00:00.000Z",
};

async function fetchSales(createClient: typeof createTcgplayerMarketClient) {
  const transport: TcgplayerMarketTransport = {
    mpGateway: { post: async <T>() => [] as T },
    mpApi: {
      post: async <T>(_path: string, request?: unknown) => {
        expect(request).toMatchObject({ listingType: "ListingWithoutPhotos" });
        return { previousPage: "", nextPage: "", resultCount: 1, totalResults: 1, data: [sale] } as T;
      },
    },
    mpSearchApi: {
      post: async <T>() =>
        ({ errors: [], results: [{ totalResults: 0, resultId: "synthetic", aggregations: {}, results: [] }] }) as T,
    },
    infiniteApi: { get: async <T>() => ({ count: 0, result: [] }) as T },
  };
  const result = await createClient(transport).fetchSecondary({
    productId: 1,
    policy: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
    now: () => "2026-09-01T15:00:00.000Z",
  });
  return result.observation.sales;
}

describe("provider-observation-listing-type-mismatch", () => {
  it("rejects photo sales under a raw request and downgrades client coverage", async () => {
    expect(
      decodeLatestSales(
        { previousPage: "", nextPage: "", resultCount: 1, totalResults: 1, data: [sale] },
        "ListingWithoutPhotos",
      ),
    ).toMatchObject({ rejectedRows: 1, diagnostics: ["sale-listing-type-mismatch"], data: [] });
    expect(
      decodeLatestSales({ previousPage: "", nextPage: "", resultCount: 1, totalResults: 1, data: [sale] }, "All")
        .data,
    ).toHaveLength(1);
    const sales = await fetchSales(createTcgplayerMarketClient);
    expect(sales).toMatchObject({ rows: [], rejectedRows: 1, coverage: "unknown", returnedCount: 0 });
    expect(JSON.stringify(sales)).not.toContain(sale.customListingId);
  });

  it("turns red when a mismatched sale is admitted", async () => {
    await expectSourceMutantRed<{ createTcgplayerMarketClient: typeof createTcgplayerMarketClient }>(
      {
        id: "photo-sale-admitted",
        defect: "requested listing-type guard removed",
        mutations: [
          {
            file: "integrations/tcgplayer/response-decoders.ts",
            find: 'requestedListingType !== "All" && listingType !== requestedListingType',
            replace: "false",
          },
        ],
      },
      "integrations/tcgplayer/market-client.ts",
      ["mismatch"],
      async (module) => {
        const sales = await fetchSales(module.createTcgplayerMarketClient);
        if (sales.rejectedRows !== 1 || sales.coverage !== "unknown" || sales.rows.length !== 0) {
          throw new Error("mismatch: photo sale admitted under raw request");
        }
      },
    );
  });
});

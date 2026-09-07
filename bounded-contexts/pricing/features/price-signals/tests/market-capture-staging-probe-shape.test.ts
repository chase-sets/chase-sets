import { describe, expect, it } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { createPriceSignalRuntime } from "../api/runtime";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import {
  createObjectStorageTcgplayerMarketCaptureReceiptSink,
  type TcgplayerMarketCaptureReceiptV1,
} from "../integrations/tcgplayer/capture-sanitizer";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

describe("tcgplayer-market-capture-v1 response-receipt shape", () => {
  it("composes one privacy-safe sink receipt from field summaries captured before decoding", async () => {
    const receipts: TcgplayerMarketCaptureReceiptV1[] = [];
    const retainedObjects: Array<Readonly<{ key: string; body: Uint8Array; visibility: string }>> = [];
    const pool = new SyntheticProductionPool();
    const receiptSink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
      putObject: async (object) => void retainedObjects.push(object),
    });
    const runtime = createPriceSignalRuntime({
      db: pool,
      pool,
      tcgplayerMarketTransport: syntheticTransport(),
      tcgplayerMarketCaptureReceiptSink: {
        retain: async (receipt) => {
          receipts.push(receipt);
          await receiptSink.retain(receipt);
        },
      },
    });

    await expect(runtime.runTcgplayerMarketCapture()).resolves.toMatchObject({
      status: "completed",
      capturesCommitted: 1,
    });
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({
      kind: "tcgplayer-market-capture-v1",
      lifecycle: {
        fieldSummaryCapturedAt: "response-receipt-before-decode",
        retainedAt: "after-immutable-capture-commit",
      },
      responseSummary: {
        salesReturned: 1,
        listingReturned: 1,
        historyResults: 1,
        maximumTupleMultiplicity: 1,
        captureLocalJointRows: 1,
      },
    });
    const listingFields = receipt.responseSummary.fieldPresenceAndTypes.listingPages[0]!.items.fields;
    expect(listingFields.find((field) => field.field === "sellerKey")).toEqual({
      field: "sellerKey",
      presentCount: 1,
      missingCount: 0,
      observedTypes: ["string"],
    });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-external-seller-secret");
    expect(receipt).not.toHaveProperty("responseBody");
    expect(retainedObjects).toHaveLength(1);
    expect(retainedObjects[0]).toMatchObject({
      key: `provider-evidence/tcgplayer-market-captures/${encodeURIComponent(receipt.captureId)}.json`,
      visibility: "private",
    });
    const retainedArtifact = new TextDecoder().decode(retainedObjects[0]!.body);
    expect(JSON.parse(retainedArtifact)).toEqual(receipt);
    expect(retainedArtifact).not.toContain("synthetic-external-seller-secret");
  });
});

class SyntheticProductionPool implements PgTransactionalPool {
  async connect(): Promise<PgPoolClient> {
    return { query: this.query.bind(this), release: () => undefined };
  }

  async query<Row = Record<string, unknown>>(sql: string) {
    if (sql.includes("policy_key = 'pricing.price-signal'")) {
      return { rows: [{ event_id: "synthetic-signal-r1", value: { productsPerPass: 1 } } as Row] };
    }
    if (sql.includes("policy_key = 'pricing.provider-observation'")) {
      return {
        rows: [
          {
            event_id: "synthetic-observation-r1",
            value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
          } as Row,
        ],
      };
    }
    if (sql.includes("policy_key = 'pricing.market-stat-hygiene'")) {
      return { rows: [{ event_id: "synthetic-stat-r1", value: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } as Row] };
    }
    if (sql.includes("FROM pricing_external_catalog_item_reference_inputs")) {
      return {
        rows: [
          {
            external_key: "product:7001",
            catalog_item_id: "cat_unmistakably_synthetic",
            sku_external_key: "sku:9001",
            catalog_product_key: "cat_unmistakably_synthetic::",
          } as Row,
        ],
      };
    }
    if (sql.includes("FROM pricing_external_market_capture_cursors")) return { rows: [] as Row[] };
    if (sql.includes("FROM pricing_external_product_reference_inputs")) {
      return {
        rows: [
          {
            catalog_item_id: "cat_unmistakably_synthetic",
            catalog_product_key: "cat_unmistakably_synthetic::",
          } as Row,
        ],
      };
    }
    if (sql.includes("INSERT INTO pricing_external_market_captures")) {
      return { rows: [{ capture_id: "synthetic-capture" } as Row] };
    }
    return { rows: [] as Row[] };
  }
}

function syntheticTransport(): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>() =>
        [
          {
            skuId: 9001,
            marketPrice: 10,
            lowestPrice: 9,
            highestPrice: 11,
            priceCount: 3,
            calculatedAt: "2026-09-01T15:00:00.000Z",
          },
        ] as T,
    },
    mpApi: {
      post: async <T>() =>
        ({
          previousPage: "",
          nextPage: "",
          resultCount: 1,
          totalResults: 1,
          data: [
            {
              condition: "Near Mint",
              variant: "Normal",
              language: "English",
              quantity: 1,
              title: "synthetic",
              listingType: "All",
              customListingId: "synthetic-transient-sale",
              purchasePrice: 5,
              shippingPrice: 0,
              orderDate: "2026-09-01T00:00:00.000Z",
            },
          ],
        }) as T,
    },
    mpSearchApi: {
      post: async <T>() =>
        ({
          errors: [],
          results: [
            {
              totalResults: 1,
              resultId: "synthetic-result",
              aggregations: {},
              results: [syntheticListing()],
            },
          ],
        }) as T,
    },
    infiniteApi: {
      get: async <T>() =>
        ({
          count: 1,
          result: [
            {
              skuId: "9001",
              variant: "Normal",
              language: "English",
              condition: "Near Mint",
              averageDailyQuantitySold: "1",
              averageDailyTransactionCount: "1",
              totalQuantitySold: "1",
              totalTransactionCount: "1",
              trendingMarketPricePercentages: {},
              buckets: [],
            },
          ],
        }) as T,
    },
  };
}

function syntheticListing() {
  return {
    directProduct: false,
    goldSeller: false,
    listingId: 1,
    channelId: 0,
    conditionId: 1,
    verifiedSeller: true,
    directInventory: 0,
    rankedShippingPrice: 0,
    productId: 7001,
    printing: "Normal",
    languageAbbreviation: "EN",
    sellerName: "synthetic-external-seller-secret",
    forwardFreight: false,
    sellerShippingPrice: 0,
    language: "English",
    shippingPrice: 0,
    condition: "Near Mint",
    languageId: 1,
    score: 0,
    directSeller: false,
    productConditionId: 1,
    sellerId: "synthetic-external-seller-secret",
    listingType: "standard",
    sellerRating: 100,
    sellerSales: "1",
    quantity: 1,
    sellerKey: "synthetic-external-seller-secret",
    price: 10,
    customData: { images: [] },
  };
}

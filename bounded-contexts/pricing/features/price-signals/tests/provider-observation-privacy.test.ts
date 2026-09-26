import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import {
  createObjectStorageTcgplayerMarketCaptureReceiptSink,
  sanitizeTcgplayerMarketCaptureReceipt,
} from "../integrations/tcgplayer/capture-sanitizer";
import type { TcgplayerSecondaryObservation } from "../integrations/tcgplayer/market-client";
import { emptyTcgplayerResponseFieldSummary } from "../integrations/tcgplayer/response-receipt";
import { pricingProviderObservationsSchemaSql } from "../read-model/provider-observations-schema";

describe("provider observation privacy boundary", () => {
  it("discards every C12 value before capture, receipt, and private artifact construction", async () => {
    const observation = secondary([
      listing("external-seller-secret", "Near Mint", 10),
      listing("external-seller-secret", "Lightly Played", 5),
    ]);
    const capture = mapProviderObservationCapture({
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      productExternalKey: "product:7001",
      catalogProductKeysBySku: new Map(),
      signalPassStartedAt: "2026-09-01T14:59:00.000Z",
      signalPolicy: { revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } },
      captureStartedAt: "2026-09-01T15:00:00.000Z",
      captureCompletedAt: "2026-09-01T15:00:01.000Z",
      observationPolicy: { revisionId: "synthetic-observation-r1", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
      statHygienePolicyRevisionId: "synthetic-stat-r1",
      authenticatedRequest: true,
      recordedSignalCount: 1,
      unresolvedSignalCount: 0,
      observation,
    });
    const phases = { sales: null, listings: null, history: null };
    const receipt = sanitizeTcgplayerMarketCaptureReceipt(capture, emptyTcgplayerResponseFieldSummary(), phases);
    expect(receipt.responseSummary.endpointDiagnostics).toEqual({
      sales: { failurePhase: null, httpStatusClass: "none" },
      listings: { failurePhase: null, httpStatusClass: "none" },
      history: { failurePhase: null, httpStatusClass: "none" },
    });
    const durable = JSON.stringify({ capture, receipt });
    assertNoC12Values(durable);
    assertNoC12Keys(JSON.stringify(capture));
    let artifact = "";
    const sink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
      putObject: async ({ body, visibility }) => {
        expect(visibility).toBe("private");
        artifact = new TextDecoder().decode(body);
      },
    });
    await sink.retain(receipt);
    assertNoC12Values(artifact);
    const fixture = readFileSync(new URL("./fixtures/provider-observations/synthetic-single-product-90-days.json", import.meta.url), "utf8");
    assertNoC12Values(fixture);
    assertNoC12Keys(fixture);
    expect(pricingProviderObservationsSchemaSql).not.toMatch(
      /\b(?:seller_key|seller_id|seller_name|seller_rating|seller_sales|seller_badges|listing_id|custom_listing_id|title|custom_data|cookie|authorization|response_body|exception_message)\s+(?:text|jsonb|integer|bigint)/i,
    );
    expect(capture.askDepth.map((row) => row.anonymousCaptureSellerOrdinal)).toEqual([1, 1]);
    const absent = sanitizeTcgplayerMarketCaptureReceipt(
      { ...capture, header: { ...capture.header, sales: null, listings: null, history: null } },
      emptyTcgplayerResponseFieldSummary(),
      phases,
    );
    expect(absent.responseSummary.endpointDiagnostics).toEqual({
      sales: { failurePhase: null, httpStatusClass: null },
      listings: { failurePhase: null, httpStatusClass: null },
      history: { failurePhase: null, httpStatusClass: null },
    });
    expect(absent.responseSummary).toMatchObject({
      salesStatus: "not-requested",
      listingsStatus: "not-requested",
      historyStatus: "not-requested",
    });
  });

  it("rejects a sanitizer leak of sellerRating or customData.title instead of trusting safe-looking counts", () => {
    const clean = JSON.stringify({ capture: { sales: [], askDepth: [] }, receipt: { typedRows: 0 } });
    expect(() => assertNoC12Keys(clean)).not.toThrow();
    for (const leak of [
      { sellerRating: "C12_SELLER_RATING_SECRET" },
      { customData: { title: "C12_CUSTOM_TITLE_SECRET" } },
    ]) {
      expect(() => assertNoC12Keys(JSON.stringify({ receipt: leak }))).toThrow(/C12 key/);
      expect(() => assertNoC12Values(JSON.stringify({ receipt: leak }))).toThrow(/C12 value/);
    }
  });
});

const C12_KEYS = [
  "sellerKey", "sellerId", "sellerName", "sellerRating", "sellerSales", "sellerBadges", "badges",
  "listingId", "customListingId", "title", "customData", "cookie", "authorization", "responseBody", "exceptionMessage",
] as const;
const C12_MARKERS = [
  "external-seller-secret", "C12_SELLER_ID_SECRET", "C12_SELLER_NAME_SECRET", "C12_SELLER_RATING_SECRET",
  "C12_SELLER_SALES_SECRET", "C12_SELLER_BADGES_SECRET", "C12_LISTING_ID_SECRET",
  "C12_CUSTOM_LISTING_ID_SECRET", "C12_LISTING_TITLE_SECRET", "C12_CUSTOM_TITLE_SECRET",
  "C12_CUSTOM_DATA_SECRET", "C12_COOKIE_SECRET", "C12_AUTH_SECRET", "C12_RESPONSE_SECRET", "C12_EXCEPTION_SECRET",
] as const;

function assertNoC12Keys(serialized: string) {
  for (const key of C12_KEYS) {
    if (new RegExp(`"${key}"\\s*:`, "i").test(serialized)) throw new Error(`C12 key: ${key}`);
  }
}

function assertNoC12Values(serialized: string) {
  for (const marker of C12_MARKERS) {
    if (serialized.includes(marker)) throw new Error(`C12 value: ${marker}`);
  }
}

function listing(sellerKey: string, condition: string, price: number) {
  return {
    condition,
    printing: "Normal",
    language: "English",
    verifiedSeller: true,
    sellerKey,
    sellerId: "C12_SELLER_ID_SECRET",
    sellerName: "C12_SELLER_NAME_SECRET",
    sellerRating: "C12_SELLER_RATING_SECRET",
    sellerSales: "C12_SELLER_SALES_SECRET",
    sellerBadges: ["C12_SELLER_BADGES_SECRET"],
    listingId: 771234,
    customListingId: "C12_CUSTOM_LISTING_ID_SECRET",
    title: "C12_LISTING_TITLE_SECRET",
    customData: { title: "C12_CUSTOM_TITLE_SECRET", description: "C12_CUSTOM_DATA_SECRET" },
    cookie: "C12_COOKIE_SECRET",
    authorization: "C12_AUTH_SECRET",
    responseBody: "C12_RESPONSE_SECRET",
    exceptionMessage: "C12_EXCEPTION_SECRET",
    price,
    sellerShippingPrice: 0,
  };
}

function secondary(listings: ReturnType<typeof listing>[]): TcgplayerSecondaryObservation {
  return {
    sales: {
      status: "observed",
      requestedAt: "2026-09-01T15:00:00.000Z",
      responseObservedAt: "2026-09-01T15:00:00.100Z",
      rows: [],
      rejectedRows: 0,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 0,
      firstReportedTotal: 0,
      lastReportedTotal: 0,
      firstResultCount: 0,
      lastResultCount: 0,
      lastNextPage: "",
      httpStatusClass: "none",
    },
    listings: {
      status: "observed",
      requestedAt: "2026-09-01T15:00:00.000Z",
      responseObservedAt: "2026-09-01T15:00:00.100Z",
      rows: listings,
      rejectedRows: 0,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: listings.length,
      reportedTotal: listings.length,
      ownSellerExclusionApplied: false,
      httpStatusClass: "none",
    },
    history: {
      status: "observed",
      requestedAt: "2026-09-01T15:00:00.000Z",
      responseObservedAt: "2026-09-01T15:00:00.100Z",
      rows: [],
      rejectedRows: 0,
      coverage: "observed",
      resultCount: 0,
      bucketCount: 0,
      httpStatusClass: "none",
    },
  };
}

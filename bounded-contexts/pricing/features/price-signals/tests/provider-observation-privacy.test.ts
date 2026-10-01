import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import {
  createObjectStorageTcgplayerMarketCaptureReceiptSink,
  sanitizeTcgplayerMarketCaptureReceipt,
} from "../integrations/tcgplayer/capture-sanitizer";
import type { TcgplayerSecondaryObservation } from "../integrations/tcgplayer/market-client";
import type { TcgplayerEndpointStageTrace } from "../integrations/tcgplayer/market-client";
import { sanitizeEndpointStageTrace } from "../integrations/tcgplayer/market-client";
import { emptyTcgplayerResponseFieldSummary } from "../integrations/tcgplayer/response-receipt";
import { pricingProviderObservationsSchemaSql } from "../read-model/provider-observations-schema";

describe("provider observation privacy boundary", () => {
  it("recursively accepts closed status fields and refuses malformed or wrong-stage fields", () => {
    const entry = {
      page: 1,
      attempt: 2,
      stage: "terminal" as const,
      at: "2026-09-01T15:00:00.000Z",
      outcome: "aborted" as const,
      lastHttpStatus: 403,
      lastHttpStatusAttempt: 1,
      failureCode: null,
    };
    const trace = { entries: [entry], overflow: 9, retryCount: 1, cooldownCount: 1 };
    expect(sanitizeEndpointStageTrace(trace)).toEqual(trace);
    for (const invalid of [
      { ...entry, lastHttpStatus: 403.5 },
      { ...entry, lastHttpStatus: 99 },
      { ...entry, lastHttpStatus: 600 },
      { ...entry, lastHttpStatusAttempt: 0 },
      { ...entry, lastHttpStatusAttempt: 1.5 },
      { ...entry, failureCode: "secret" },
      { ...entry, headers: { cookie: "C12_SECRET_COOKIE" } },
      { ...entry, httpStatus: 403 },
      { ...entry, stage: "cooldown-start" },
      { ...entry, lastHttpStatus: null },
    ])
      expect(
        sanitizeEndpointStageTrace({ ...trace, entries: [invalid] } as TcgplayerEndpointStageTrace),
      ).toBeUndefined();
    for (const status of [99, 600, 403.5, "403"]) {
      expect(
        sanitizeEndpointStageTrace({
          ...trace,
          entries: [
            { page: 1, attempt: 1, stage: "headers-received", at: entry.at, statusClass: "4xx", httpStatus: status },
          ],
        } as TcgplayerEndpointStageTrace),
      ).toBeUndefined();
    }
  });

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
      sales: { failurePhase: null, httpStatusClass: "none", lastHttpStatus: null, failureClass: "unknown" },
      listings: { failurePhase: null, httpStatusClass: "none", lastHttpStatus: null, failureClass: "unknown" },
      history: { failurePhase: null, httpStatusClass: "none", lastHttpStatus: null, failureClass: "unknown" },
    });
    const durable = JSON.stringify({ capture, receipt });
    assertNoC12Values(durable);
    assertNoC12Keys(JSON.stringify(capture));
    assertNoC12Keys(JSON.stringify(receipt));
    let artifact = "";
    const sink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
      putObject: async ({ body, visibility }) => {
        expect(visibility).toBe("private");
        artifact = new TextDecoder().decode(body);
      },
    });
    await sink.retain(receipt);
    assertNoC12Values(artifact);
    assertNoC12Keys(artifact);
    const fixture = readFileSync(
      new URL("./fixtures/provider-observations/synthetic-single-product-90-days.json", import.meta.url),
      "utf8",
    );
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
      sales: { failurePhase: null, httpStatusClass: null, lastHttpStatus: null, failureClass: "unknown" },
      listings: { failurePhase: null, httpStatusClass: null, lastHttpStatus: null, failureClass: "unknown" },
      history: { failurePhase: null, httpStatusClass: null, lastHttpStatus: null, failureClass: "unknown" },
    });
    expect(absent.responseSummary).toMatchObject({
      salesStatus: "not-requested",
      listingsStatus: "not-requested",
      historyStatus: "not-requested",
    });
    const safeTrace: TcgplayerEndpointStageTrace = {
      entries: [{ page: 1, attempt: 1, stage: "headers-received", at: "2026-09-01T15:00:00.000Z", statusClass: "4xx" }],
      overflow: 0,
      retryCount: 0,
      cooldownCount: 0,
    };
    const safe = sanitizeTcgplayerMarketCaptureReceipt(capture, emptyTcgplayerResponseFieldSummary(), phases, {
      sales: safeTrace,
    });
    expect(safe.responseSummary.endpointDiagnostics?.sales.stageTrace).toEqual(safeTrace);
    for (const entry of [
      { ...safeTrace.entries[0], body: "C12_SECRET_COOKIE" },
      { ...safeTrace.entries[0], at: "2026-09-01" },
      { ...safeTrace.entries[0], attempt: 10001 },
      { ...safeTrace.entries[0], statusClass: "403" },
    ]) {
      const invalid = sanitizeTcgplayerMarketCaptureReceipt(capture, emptyTcgplayerResponseFieldSummary(), phases, {
        sales: { ...safeTrace, entries: [entry] } as TcgplayerEndpointStageTrace,
      });
      expect(invalid.responseSummary.endpointDiagnostics?.sales).not.toHaveProperty("stageTrace");
      assertNoC12Values(JSON.stringify(invalid));
    }
    const overflow = sanitizeTcgplayerMarketCaptureReceipt(capture, emptyTcgplayerResponseFieldSummary(), phases, {
      sales: { ...safeTrace, entries: Array.from({ length: 65 }, () => safeTrace.entries[0]!) },
    });
    expect(overflow.responseSummary.endpointDiagnostics?.sales).not.toHaveProperty("stageTrace");
  });

  it("self-tests the C12 key and value assertions against hand-built leaks", () => {
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
  "sellerKey",
  "sellerId",
  "sellerName",
  "sellerRating",
  "sellerSales",
  "sellerBadges",
  "badges",
  "listingId",
  "customListingId",
  "title",
  "customData",
  "cookie",
  "authorization",
  "responseBody",
  "exceptionMessage",
] as const;
const C12_MARKERS = [
  "external-seller-secret",
  "C12_SELLER_ID_SECRET",
  "C12_SELLER_NAME_SECRET",
  "C12_SELLER_RATING_SECRET",
  "C12_SELLER_SALES_SECRET",
  "C12_SELLER_BADGES_SECRET",
  "C12_LISTING_ID_SECRET",
  "C12_CUSTOM_LISTING_ID_SECRET",
  "C12_LISTING_TITLE_SECRET",
  "C12_CUSTOM_TITLE_SECRET",
  "C12_CUSTOM_DATA_SECRET",
  "C12_COOKIE_SECRET",
  "C12_AUTH_SECRET",
  "C12_RESPONSE_SECRET",
  "C12_EXCEPTION_SECRET",
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

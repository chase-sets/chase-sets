import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import { sanitizeTcgplayerMarketCaptureReceipt } from "../integrations/tcgplayer/capture-sanitizer";
import type { TcgplayerSecondaryObservation } from "../integrations/tcgplayer/market-client";
import { emptyTcgplayerResponseFieldSummary } from "../integrations/tcgplayer/response-receipt";

describe("provider observation privacy boundary", () => {
  it("discards external identity before durable construction", () => {
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
    const receipt = sanitizeTcgplayerMarketCaptureReceipt(capture, emptyTcgplayerResponseFieldSummary());
    const durable = JSON.stringify({ capture, receipt });
    expect(durable).not.toContain("external-seller-secret");
    expect(JSON.stringify(capture)).not.toMatch(
      /sellerKey|sellerId|sellerName|listingId|customListingId|cookie|authorization|responseBody|exceptionMessage/i,
    );
    expect(capture.askDepth.map((row) => row.anonymousCaptureSellerOrdinal)).toEqual([1, 1]);
  });
});

function listing(sellerKey: string, condition: string, price: number) {
  return {
    condition,
    printing: "Normal",
    language: "English",
    verifiedSeller: true,
    sellerKey,
    sellerId: "",
    sellerName: "",
    listingId: 1,
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

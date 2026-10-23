import type { SecondaryProduct, TcgplayerMarketObservationPosture } from "@chase-sets/tcgplayer-market-observations";
import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";

const posture: TcgplayerMarketObservationPosture = {
  salesOffset: 0,
  salesLimit: 2,
  salesPageSize: 2,
  salesPageBudget: 1,
  salesConditions: [1],
  salesLanguages: [1],
  salesVariants: [1],
  salesListingType: "All",
  listingsVerifiedOnly: true,
  listingsPageSize: 2,
  listingsPageBudget: 1,
  listingsDeliveredCeiling: "100.00",
  historyRange: "annual",
  timeoutMs: 777,
};

describe("reduced provider observation mapping", () => {
  it("keeps extension ordinals, scales delivered cents before reduction, and retains every row", () => {
    const capture = mapProviderObservationCapture(
      input({
        listings: [
          listing(7, "Near Mint", "0.10", "0.20", "Normal"),
          listing(7, "Near Mint", "0.10", "0.20", "Normal"),
          listing(9, "Near Mint", "0.11", "0.20", "Normal"),
          listing(9, "Near Mint", "0.10", "0.21", "Foil"),
        ],
      }),
    );
    expect(capture.askDepth).toEqual([
      expect.objectContaining({ anonymousCaptureSellerOrdinal: 7, deliveredAmount: "0.30" }),
      expect.objectContaining({ anonymousCaptureSellerOrdinal: 9, deliveredAmount: "0.31" }),
    ]);
    expect(capture.snapshots).toEqual([
      expect.objectContaining({ providerVariant: "Normal", distinctSellerCount: 2, cheapestDeliveredAmount: "0.30" }),
      expect.objectContaining({ providerVariant: "Foil", distinctSellerCount: 1, cheapestDeliveredAmount: "0.31" }),
    ]);
  });

  it("records executed posture and credential provenance instead of policy posture", () => {
    const capture = mapProviderObservationCapture(
      input({
        listings: [],
        credentials: ["omit", "include", "omit"],
      }),
    );
    const { timeoutMs: _timeoutMs, ...expectedPosture } = posture;
    expect(capture.header.requestPosture).toEqual(expectedPosture);
    expect(capture.header.requestPosture).not.toHaveProperty("timeoutMs");
    expect(capture.header.requestPosture?.salesLimit).toBe(2);
    expect(capture.header.observationPolicyRevisionId).toBe("frozen-policy-r2");
    expect(capture.header.capturesPerPass).toBe(5);
    expect(capture.header.authenticatedRequest).toBe(true);
    expect(capture.header.listings?.ownSellerExclusionApplied).toBe(false);
  });
});

function input(options: {
  listings: readonly SecondaryProduct["listings"]["rows"][number][];
  credentials?: readonly ("omit" | "include")[];
}) {
  const credentials = options.credentials ?? ["omit", "omit", "omit"];
  const endpoint = (index: number) => ({
    status: "observed" as const,
    httpStatusClass: "none" as const,
    credentialsMode: credentials[index]!,
    requestedAt: "2026-09-01T00:00:00.000Z",
    responseObservedAt: "2026-09-01T00:00:01.000Z",
    rejectedRows: 0,
  });
  const observation: SecondaryProduct = {
    productId: 7001,
    sales: {
      ...endpoint(0),
      rows: [],
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 0,
      firstReportedTotal: 0,
      lastReportedTotal: 0,
      firstResultCount: 0,
      lastResultCount: 0,
      lastNextPage: "",
    },
    listings: {
      ...endpoint(1),
      rows: options.listings,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: options.listings.length,
      reportedTotal: options.listings.length,
    },
    history: { ...endpoint(2), rows: [], coverage: "observed", resultCount: 0, bucketCount: 0 },
  };
  return {
    providerKey: "tcgplayer",
    catalogItemId: "cat_synthetic",
    productExternalKey: "product:7001",
    catalogProductKeysBySku: new Map(),
    signalPassStartedAt: "2026-09-01T00:00:00.000Z",
    signalPolicy: { revisionId: "signal-r1", value: { productsPerPass: 1 } },
    captureStartedAt: "2026-09-01T00:00:00.000Z",
    captureCompletedAt: "2026-09-01T00:00:02.000Z",
    observationPolicy: { revisionId: "frozen-policy-r2", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
    statHygienePolicyRevisionId: "stat-r1",
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    executedPosture: posture,
    observation,
  };
}

function listing(sellerOrdinal: number, condition: string, price: string, shipping: string, printing: string) {
  return { sellerOrdinal, condition, printing, language: "English", price, sellerShippingPrice: shipping };
}

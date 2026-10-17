import { pathToFileURL } from "node:url";
import { mapProviderObservationCapture } from "../../../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../../domain/provider-observation-policy";
import type { TcgplayerSecondaryObservation } from "../../../integrations/tcgplayer/market-client";

export function generateSyntheticProviderObservationFixture() {
  const captureStartedAt = "2026-09-01T15:00:00.000Z";
  const sales = Array.from({ length: 90 }, (_, index) => ({
    condition: index % 2 === 0 ? "Near Mint" : "Lightly Played",
    variant: "Normal",
    language: "English",
    quantity: (index % 3) + 1,
    listingType: "ListingWithoutPhotos",
    customListingId: `synthetic-transient-sale-${index + 1}`,
    purchasePrice: 5 + (index % 17) * 0.25,
    shippingPrice: index % 4 === 0 ? 1 : 0,
    orderDate: new Date(Date.parse(captureStartedAt) - index * 24 * 60 * 60 * 1_000).toISOString(),
  }));
  const listings = [
    syntheticListing("synthetic-transient-a", "Near Mint", 10, 1),
    syntheticListing("synthetic-transient-a", "Moderately Played", 5, 2),
    syntheticListing("synthetic-transient-b", "Near Mint", 20, 3),
    syntheticListing("synthetic-transient-b", "Moderately Played", 6, 4),
  ];
  const observation: TcgplayerSecondaryObservation = {
    sales: {
      status: "observed",
      requestedAt: captureStartedAt,
      responseObservedAt: "2026-09-01T15:00:00.100Z",
      rows: sales,
      rejectedRows: 0,
      coverage: "complete",
      pagesFetched: 4,
      returnedCount: 90,
      firstReportedTotal: 90,
      lastReportedTotal: 90,
      firstResultCount: 25,
      lastResultCount: 15,
      lastNextPage: "",
      httpStatusClass: "none",
    },
    listings: {
      status: "observed",
      requestedAt: captureStartedAt,
      responseObservedAt: "2026-09-01T15:00:00.200Z",
      rows: listings,
      rejectedRows: 0,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 4,
      reportedTotal: 4,
      ownSellerExclusionApplied: false,
      httpStatusClass: "none",
    },
    history: {
      status: "observed",
      requestedAt: captureStartedAt,
      responseObservedAt: "2026-09-01T15:00:00.300Z",
      rows: [],
      rejectedRows: 0,
      coverage: "observed",
      resultCount: 0,
      bucketCount: 0,
      httpStatusClass: "none",
    },
  };
  const capture = mapProviderObservationCapture({
    providerKey: "tcgplayer",
    catalogItemId: "cat_unmistakably_synthetic_provider_fixture",
    productExternalKey: "product:700000001",
    catalogProductKeysBySku: new Map(),
    signalPassStartedAt: "2026-09-01T14:59:00.000Z",
    signalPolicy: { revisionId: "synthetic-signal-policy-r1", value: { productsPerPass: 1 } },
    captureStartedAt,
    captureCompletedAt: "2026-09-01T15:00:01.000Z",
    observationPolicy: {
      revisionId: "synthetic-observation-policy-r1",
      value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
    },
    statHygienePolicyRevisionId: "synthetic-stat-hygiene-policy-r1",
    authenticatedRequest: false,
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    observation,
  });
  return {
    schema: "synthetic-provider-observation-fixture/v1",
    sourceCommit: "bdeffa0190be035084abccb464716aaaa2541a59",
    status: "synthetic-not-live-not-parity",
    observedDayCount: 90,
    capture,
  };
}

function syntheticListing(sellerKey: string, condition: string, price: number, listingId: number) {
  return {
    condition,
    printing: "Normal",
    language: "English",
    verifiedSeller: true,
    sellerKey,
    sellerId: "",
    sellerName: "",
    listingId,
    price,
    sellerShippingPrice: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(generateSyntheticProviderObservationFixture(), null, 2)}\n`);
}

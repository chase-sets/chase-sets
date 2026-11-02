import { pathToFileURL } from "node:url";
import type { SecondaryProduct } from "@chase-sets/tcgplayer-market-observations";
import { mapProviderObservationCapture } from "../../../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../../domain/provider-observation-policy";

export function generateSyntheticProviderObservationFixture() {
  const captureStartedAt = "2026-09-01T15:00:00.000Z";
  const sales = Array.from({ length: 90 }, (_, index) => ({
    condition: index % 2 === 0 ? "Near Mint" : "Lightly Played",
    variant: "Normal",
    language: "English",
    quantity: (index % 3) + 1,
    listingType: "ListingWithoutPhotos",
    purchasePrice: (5 + (index % 17) * 0.25).toFixed(2),
    shippingPrice: (index % 4 === 0 ? 1 : 0).toFixed(2),
    orderDate: new Date(Date.parse(captureStartedAt) - index * 24 * 60 * 60 * 1_000).toISOString(),
  }));
  const listings = [
    syntheticListing("Near Mint", 10, 1),
    syntheticListing("Moderately Played", 5, 1),
    syntheticListing("Near Mint", 20, 2),
    syntheticListing("Moderately Played", 6, 2),
  ];
  const observation: SecondaryProduct = {
    productId: 700000001,
    sales: {
      status: "observed",
      httpStatusClass: "none",
      credentialsMode: "include",
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
    },
    listings: {
      status: "observed",
      httpStatusClass: "none",
      credentialsMode: "include",
      requestedAt: captureStartedAt,
      responseObservedAt: "2026-09-01T15:00:00.200Z",
      rows: listings,
      rejectedRows: 0,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 4,
      reportedTotal: 4,
    },
    history: {
      status: "observed",
      httpStatusClass: "none",
      credentialsMode: "omit",
      requestedAt: captureStartedAt,
      responseObservedAt: "2026-09-01T15:00:00.300Z",
      rows: [],
      rejectedRows: 0,
      coverage: "observed",
      resultCount: 0,
      bucketCount: 0,
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
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    executedPosture: {
      salesOffset: 0,
      salesLimit: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.limit,
      salesPageSize: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.pageSize,
      salesPageBudget: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.pageBudget,
      salesConditions: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.conditions,
      salesLanguages: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.languages,
      salesVariants: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.variants,
      salesListingType: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales.listingType,
      listingsVerifiedOnly: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings.verifiedSellersOnly,
      listingsPageSize: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings.pageSize,
      listingsPageBudget: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings.pageBudget,
      listingsDeliveredCeiling: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings.deliveredCeiling,
      historyRange: "annual",
      timeoutMs: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.secondaryTimeoutMs,
    },
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

function syntheticListing(condition: string, price: number, sellerOrdinal: number) {
  return {
    condition,
    printing: "Normal",
    language: "English",
    sellerOrdinal,
    price: price.toFixed(2),
    sellerShippingPrice: "0.00",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(generateSyntheticProviderObservationFixture(), null, 2)}\n`);
}

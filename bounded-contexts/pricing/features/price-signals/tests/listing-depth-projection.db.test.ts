import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type {
  EndpointStatus,
  ListingsCoverage,
  TcgplayerSecondaryObservation,
} from "../integrations/tcgplayer/market-client";
import {
  countProviderCompetingSellersAt,
  latestProviderMarketCapture,
  listProviderListingAskDepth,
  listProviderListingSnapshots,
} from "../read-model/provider-observation-queries";
import {
  commitProviderObservationCapture,
  type MarketCaptureWorkItem,
} from "../read-model/provider-observation-writes";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("listing snapshot grain, currentness, and omitted-state truth", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_listing_depth");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("keeps variant/language/condition snapshots independent from the condition seller joint", async () => {
    const first = capture("2026-09-01T15:00:00.000Z", [
      listing("seller-a", "Near Mint", 10, "Normal"),
      listing("seller-a", "Near Mint", 20, "Foil"),
      listing("seller-b", "Unrecognized Provider Condition", 5, "Normal"),
      listing("seller-c", "Near Mint", 100, "Normal"),
    ]);
    expect(first.snapshots.map((row) => [row.providerVariant, row.providerCondition])).toEqual([
      ["Normal", "Near Mint"],
      ["Foil", "Near Mint"],
      ["Normal", "Unrecognized Provider Condition"],
    ]);
    expect(first.askDepth).toHaveLength(3);
    await commitProviderObservationCapture(pool, "tcgplayer", work("", 0, "product:7001", 1), first);

    const firstSnapshots = await listProviderListingSnapshots(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      observedSince: "2026-09-01",
    });
    expect(firstSnapshots.map((row) => row.providerVariant)).toEqual(["Foil", "Normal", "Normal"]);
    await expect(
      countProviderCompetingSellersAt(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: first.header.captureId,
        deliveredAmount: "10.00",
      }),
    ).resolves.toEqual({ count: 2, coverage: "complete" });

    const empty = capture("2026-09-01T16:00:00.000Z", []);
    await commitProviderObservationCapture(pool, "tcgplayer", work("product:7001", 1, "", 2), empty);
    await expect(
      listProviderListingSnapshots(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        observedSince: "2026-09-01",
      }),
    ).resolves.toEqual([]);
    await expect(
      listProviderListingAskDepth(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: empty.header.captureId,
      }),
    ).resolves.toEqual({ captureId: empty.header.captureId, coverage: "complete", conditions: [], product: [] });
    await expect(
      countProviderCompetingSellersAt(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: empty.header.captureId,
        deliveredAmount: "10.00",
      }),
    ).resolves.toEqual({ count: 0, coverage: "complete" });
  });

  it.each([
    ["observed-empty", "observed", "complete"],
    ["unavailable", "unavailable", "unknown"],
    ["disabled", "disabled", "unknown"],
    ["truncated", "observed", "page-budget-truncated"],
    ["unknown", "observed", "unknown"],
  ] as const)("preserves %s header truth when child rows are omitted", async (_label, status, coverage) => {
    const providerKey = `synthetic-${_label}`;
    const empty = capture("2026-09-01T15:00:00.000Z", [], status, coverage, providerKey);
    await commitProviderObservationCapture(pool, providerKey, work("", 0, "", 1), empty);
    await expect(
      listProviderListingAskDepth(pool, {
        providerKey,
        catalogItemId: "cat_synthetic",
        captureId: empty.header.captureId,
      }),
    ).resolves.toMatchObject({ coverage });
    await expect(
      latestProviderMarketCapture(pool, {
        providerKey,
        catalogItemId: "cat_synthetic",
        asOf: "2026-09-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ endpoints: { listings: { status, coverage } } });
  });

  it("drives the public raw depth count for second, third, and later asks", async () => {
    const captured = capture("2026-09-01T15:00:00.000Z", [
      listing("seller-a", "Near Mint", 5),
      listing("seller-b", "Near Mint", 6),
      listing("seller-c", "Near Mint", 7),
    ]);
    await commitProviderObservationCapture(pool, "tcgplayer", work("", 0, "", 1), captured);
    await expect(
      countProviderCompetingSellersAt(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: captured.header.captureId,
        deliveredAmount: "10.00",
      }),
    ).resolves.toEqual({ count: 3, coverage: "complete" });
  });
});

function capture(
  captureStartedAt: string,
  listings: ReturnType<typeof listing>[],
  status: EndpointStatus = "observed",
  coverage: ListingsCoverage = "complete",
  providerKey = "tcgplayer",
) {
  const observation: TcgplayerSecondaryObservation = {
    sales: emptySales(captureStartedAt),
    listings: {
      status,
      requestedAt: captureStartedAt,
      responseObservedAt: status === "observed" ? captureStartedAt : null,
      rows: listings,
      rejectedRows: 0,
      coverage,
      pagesFetched: status === "observed" ? 1 : 0,
      returnedCount: listings.length,
      reportedTotal: status === "observed" ? listings.length : null,
      ownSellerExclusionApplied: false,
      httpStatusClass: status === "unavailable" ? "5xx" : "none",
    },
    history: {
      status: "not-requested",
      requestedAt: captureStartedAt,
      responseObservedAt: null,
      rows: [],
      rejectedRows: 0,
      coverage: "unknown",
      resultCount: 0,
      bucketCount: 0,
      httpStatusClass: "none",
    },
  };
  return mapProviderObservationCapture({
    providerKey,
    catalogItemId: "cat_synthetic",
    productExternalKey: "product:7001",
    catalogProductKeysBySku: new Map(),
    signalPassStartedAt: "2026-09-01T14:59:00.000Z",
    signalPolicy: { revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } },
    captureStartedAt,
    captureCompletedAt: captureStartedAt,
    observationPolicy: { revisionId: "synthetic-observation-r1", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
    statHygienePolicyRevisionId: "synthetic-stat-r1",
    authenticatedRequest: false,
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    observation,
  });
}

function emptySales(at: string): TcgplayerSecondaryObservation["sales"] {
  return {
    status: "not-requested",
    requestedAt: at,
    responseObservedAt: null,
    rows: [],
    rejectedRows: 0,
    coverage: "unknown",
    pagesFetched: 0,
    returnedCount: 0,
    firstReportedTotal: null,
    lastReportedTotal: null,
    firstResultCount: null,
    lastResultCount: null,
    lastNextPage: null,
    httpStatusClass: "none",
  };
}

function listing(sellerKey: string, condition: string, price: number, printing = "Normal") {
  return {
    condition,
    printing,
    language: "English",
    verifiedSeller: true,
    sellerKey,
    sellerId: sellerKey,
    sellerName: sellerKey,
    listingId: price,
    price,
    sellerShippingPrice: 0,
  };
}

function work(
  afterExternalKey: string,
  generation: number,
  nextAfter: string,
  nextGeneration: number,
): MarketCaptureWorkItem {
  return {
    productExternalKey: "product:7001",
    productId: 7001,
    catalogItemId: "cat_synthetic",
    skus: [],
    expectedCursor: { afterExternalKey, generation },
    nextCursor: { afterExternalKey: nextAfter, generation: nextGeneration },
  };
}

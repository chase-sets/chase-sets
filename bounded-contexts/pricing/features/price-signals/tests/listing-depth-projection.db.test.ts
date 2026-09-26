import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  countProviderCompetingSellersAt,
  listProviderListingAskDepth,
  listProviderListingAskGroups,
} from "@chase-sets/pricing/server";
import { module as pricingModule } from "../../../index";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type {
  EndpointStatus,
  ListingsCoverage,
  TcgplayerSecondaryObservation,
} from "../integrations/tcgplayer/market-client";
import { latestProviderMarketCapture, listProviderListingSnapshots } from "../read-model/provider-observation-queries";
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
    ["ceiling-truncated", "observed", "ceiling-truncated"],
    ["inconsistent", "observed", "inconsistent"],
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
    ).resolves.toEqual({ captureId: empty.header.captureId, coverage, conditions: [], product: [] });
    await expect(
      countProviderCompetingSellersAt(pool, {
        providerKey,
        catalogItemId: "cat_synthetic",
        captureId: empty.header.captureId,
        deliveredAmount: "10.00",
      }),
    ).resolves.toEqual({ count: 0, coverage });
    await expect(
      listProviderListingAskGroups(pool, {
        providerKey,
        catalogItemId: "cat_synthetic",
        captureId: empty.header.captureId,
      }),
    ).resolves.toEqual([]);
    await expect(
      latestProviderMarketCapture(pool, {
        providerKey,
        catalogItemId: "cat_synthetic",
        asOf: "2026-09-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ endpoints: { listings: { status, coverage } } });
  });

  it("product depth counts distinct sellers across conditions", async () => {
    const expected = [
      { deliveredAmount: "5.00", cumulativeSellerCount: 1 },
      { deliveredAmount: "6.00", cumulativeSellerCount: 2 },
      { deliveredAmount: "10.00", cumulativeSellerCount: 2 },
      { deliveredAmount: "20.00", cumulativeSellerCount: 2 },
    ];
    for (const [providerKey, asks] of [
      [
        "synthetic-joint-one",
        [
          [10, 5],
          [20, 6],
        ],
      ],
      [
        "synthetic-joint-two",
        [
          [10, 6],
          [20, 5],
        ],
      ],
    ] as const) {
      const captured = capture(
        "2026-09-01T15:00:00.000Z",
        [
          listing("A", "NM", asks[0][0]),
          listing("A", "MP", asks[0][1]),
          listing("B", "NM", asks[1][0]),
          listing("B", "MP", asks[1][1]),
        ],
        "observed",
        "complete",
        providerKey,
      );
      await commitProviderObservationCapture(pool, providerKey, work("", 0, "", 1), captured);
      const params = { providerKey, catalogItemId: "cat_synthetic", captureId: captured.header.captureId };
      const depth = await listProviderListingAskDepth(pool, params);
      expect(depth).toMatchObject({ captureId: captured.header.captureId, coverage: "complete", product: expected });
      expect(depth.conditions.map(({ providerCondition, points }) => [providerCondition, points])).toEqual([
        [
          "MP",
          [
            { deliveredAmount: "5.00", cumulativeSellerCount: 1 },
            { deliveredAmount: "6.00", cumulativeSellerCount: 2 },
          ],
        ],
        [
          "NM",
          [
            { deliveredAmount: "10.00", cumulativeSellerCount: 1 },
            { deliveredAmount: "20.00", cumulativeSellerCount: 2 },
          ],
        ],
      ]);
      expect(await listProviderListingAskGroups(pool, params)).toEqual([
        {
          captureId: captured.header.captureId,
          anonymousCaptureSellerOrdinal: asks[0][1] === 5 ? 1 : 2,
          providerCondition: "MP",
          deliveredAmount: "5.00",
          coverage: "complete",
        },
        {
          captureId: captured.header.captureId,
          anonymousCaptureSellerOrdinal: asks[0][1] === 6 ? 1 : 2,
          providerCondition: "MP",
          deliveredAmount: "6.00",
          coverage: "complete",
        },
        {
          captureId: captured.header.captureId,
          anonymousCaptureSellerOrdinal: 1,
          providerCondition: "NM",
          deliveredAmount: "10.00",
          coverage: "complete",
        },
        {
          captureId: captured.header.captureId,
          anonymousCaptureSellerOrdinal: 2,
          providerCondition: "NM",
          deliveredAmount: "20.00",
          coverage: "complete",
        },
      ]);
      for (const price of ["0.00", "4.99", "5.00", "5.50", "6.00", "8.00", "10.00", "15.00", "20.00", "25.00"]) {
        const expectedCount =
          [...expected].reverse().find((point) => Number(point.deliveredAmount) <= Number(price))
            ?.cumulativeSellerCount ?? 0;
        await expect(countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: price })).resolves.toEqual({
          count: expectedCount,
          coverage: "complete",
        });
      }
      await expect(listProviderListingAskDepth(pool, params)).resolves.toEqual(depth);
    }
  });

  it("depth threshold and condition parity remains capture scoped", async () => {
    const first = capture("2026-09-01T15:00:00.000Z", [
      listing("A", "NM", 5),
      listing("B", "NM", 6),
      listing("C", "NM", 100),
      listing("A", "MP", 5),
      listing("D", "Unrecognized Provider Condition", 5),
    ]);
    const second = capture("2026-09-01T16:00:00.000Z", [
      listing("C", "NM", 7),
      listing("B", "NM", 6),
      listing("A", "NM", 5),
      listing("A", "MP", 5),
      listing("D", "Unrecognized Provider Condition", 5),
    ]);
    await commitProviderObservationCapture(pool, "tcgplayer", work("", 0, "product:7001", 1), first);
    await commitProviderObservationCapture(pool, "tcgplayer", work("product:7001", 1, "", 2), second);
    const firstGroups = await listProviderListingAskGroups(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: first.header.captureId,
    });
    const secondGroups = await listProviderListingAskGroups(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: second.header.captureId,
    });
    expect(
      firstGroups.find((row) => row.providerCondition === "NM" && row.deliveredAmount === "5.00")
        ?.anonymousCaptureSellerOrdinal,
    ).toBe(1);
    expect(
      secondGroups.find((row) => row.providerCondition === "NM" && row.deliveredAmount === "5.00")
        ?.anonymousCaptureSellerOrdinal,
    ).toBe(3);
    for (const [captured, count] of [
      [first, 3],
      [second, 4],
    ] as const) {
      const params = { providerKey: "tcgplayer", catalogItemId: "cat_synthetic", captureId: captured.header.captureId };
      const depth = await listProviderListingAskDepth(pool, params);
      expect(depth.product).toEqual(
        captured === first
          ? [
              { deliveredAmount: "5.00", cumulativeSellerCount: 2 },
              { deliveredAmount: "6.00", cumulativeSellerCount: 3 },
              { deliveredAmount: "100.00", cumulativeSellerCount: 4 },
            ]
          : [
              { deliveredAmount: "5.00", cumulativeSellerCount: 2 },
              { deliveredAmount: "6.00", cumulativeSellerCount: 3 },
              { deliveredAmount: "7.00", cumulativeSellerCount: 4 },
            ],
      );
      expect(depth.conditions.map(({ providerCondition }) => providerCondition)).toEqual([
        "MP",
        "NM",
        "Unrecognized Provider Condition",
      ]);
      for (const [price, rawCount, nmCount] of [
        ["4.99", 0, 0],
        ["5.00", 2, 1],
        ["5.50", 2, 1],
        ["6.00", 3, 2],
        ["7.50", count, count - 1],
        ["10.00", count, count - 1],
        ["101.00", 4, 3],
      ] as const) {
        await expect(countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: price })).resolves.toEqual({
          count: rawCount,
          coverage: "complete",
        });
        await expect(
          countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: price, providerCondition: "NM" }),
        ).resolves.toEqual({ count: nmCount, coverage: "complete" });
        await expect(
          countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: price, providerCondition: "MP" }),
        ).resolves.toEqual({ count: Number(price) >= 5 ? 1 : 0, coverage: "complete" });
        await expect(
          countProviderCompetingSellersAt(pool, {
            ...params,
            deliveredAmount: price,
            providerCondition: "Unrecognized Provider Condition",
          }),
        ).resolves.toEqual({ count: Number(price) >= 5 ? 1 : 0, coverage: "complete" });
      }
      await expect(listProviderListingAskDepth(pool, params)).resolves.toEqual(depth);
      for (const other of [
        { ...params, providerKey: "other-provider" },
        { ...params, catalogItemId: "other-product" },
      ]) {
        await expect(listProviderListingAskDepth(pool, other)).resolves.toEqual({
          captureId: captured.header.captureId,
          coverage: "unknown",
          conditions: [],
          product: [],
        });
        await expect(countProviderCompetingSellersAt(pool, { ...other, deliveredAmount: "10.00" })).resolves.toEqual({
          count: 0,
          coverage: "unknown",
        });
        await expect(listProviderListingAskGroups(pool, other)).resolves.toEqual([]);
      }
    }
    const missing = {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: "missing-synthetic-capture",
    };
    await expect(listProviderListingAskDepth(pool, missing)).resolves.toEqual({
      captureId: missing.captureId,
      coverage: "unknown",
      conditions: [],
      product: [],
    });
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

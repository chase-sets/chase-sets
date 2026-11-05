import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { SecondaryProduct, TcgplayerMarketObservationPosture } from "@chase-sets/tcgplayer-market-observations";
import { module as pricingModule } from "../../../index";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import { listProviderListingAskGroups } from "../read-model/provider-observation-queries";
import { commitProviderObservationCapture } from "../read-model/provider-observation-writes";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("capture-local seller/condition/amount joint", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_listing_joint");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("preserves the R4 discriminator through mapper, transaction, and public export", async () => {
    const one = captureFor("synthetic-joint-one", { A: { NM: 10, MP: 5 }, B: { NM: 20, MP: 6 } });
    const two = captureFor("synthetic-joint-two", { A: { NM: 10, MP: 6 }, B: { NM: 20, MP: 5 } });
    await commitProviderObservationCapture(pool, one);
    await commitProviderObservationCapture(pool, two);

    const oneRows = await listProviderListingAskGroups(pool, {
      providerKey: one.header.providerKey,
      catalogItemId: one.header.catalogItemId,
      captureId: one.header.captureId,
    });
    const twoRows = await listProviderListingAskGroups(pool, {
      providerKey: two.header.providerKey,
      catalogItemId: two.header.catalogItemId,
      captureId: two.header.captureId,
    });
    expect(marginals(oneRows)).toEqual(marginals(twoRows));
    expect(scaleFirstThenDedupe(oneRows, { NM: 1, MP: 2 }, 11)).toBe(1);
    expect(scaleFirstThenDedupe(twoRows, { NM: 1, MP: 2 }, 11)).toBe(2);
    expect(storeWinShare(scaleFirstThenDedupe(oneRows, { NM: 1, MP: 2 }, 11))).toBe(0.5);
    expect(storeWinShare(scaleFirstThenDedupe(twoRows, { NM: 1, MP: 2 }, 11))).toBe(0.3333);

    const dedupeBeforeScaleMutant = new Set(oneRows.map((row) => row.anonymousCaptureSellerOrdinal)).size;
    expect(dedupeBeforeScaleMutant).not.toBe(scaleFirstThenDedupe(oneRows, { NM: 1, MP: 2 }, 11));
  });
});

type Config = Readonly<Record<"A" | "B", Readonly<Record<"NM" | "MP", number>>>>;

function captureFor(providerKey: string, config: Config) {
  const listings = Object.entries(config).flatMap(([sellerKey, byCondition]) =>
    Object.entries(byCondition).map(([condition, price]) => ({
      sellerOrdinal: sellerKey === "A" ? 1 : 2,
      condition,
      printing: "Normal",
      language: "English",
      price: price.toFixed(2),
      sellerShippingPrice: "0.00",
    })),
  );
  const emptyEndpoint = {
    status: "observed" as const,
    requestedAt: "2026-09-01T15:00:00.000Z",
    responseObservedAt: "2026-09-01T15:00:00.100Z",
    rejectedRows: 0,
    httpStatusClass: "none" as const,
  };
  const observation: SecondaryProduct = {
    productId: 7001,
    sales: {
      ...emptyEndpoint,
      credentialsMode: "omit",
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
      ...emptyEndpoint,
      credentialsMode: "omit",
      rows: listings,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 4,
      reportedTotal: 4,
    },
    history: {
      ...emptyEndpoint,
      credentialsMode: "omit",
      rows: [],
      coverage: "observed",
      resultCount: 0,
      bucketCount: 0,
    },
  };
  return mapProviderObservationCapture({
    providerKey,
    catalogItemId: "cat_synthetic",
    productExternalKey: "product:7001",
    catalogProductKeysBySku: new Map(),
    signalPassStartedAt: "2026-09-01T14:59:00.000Z",
    signalPolicy: { revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } },
    captureStartedAt: "2026-09-01T15:00:00.000Z",
    captureCompletedAt: "2026-09-01T15:00:01.000Z",
    observationPolicy: { revisionId: "synthetic-observation-r1", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
    statHygienePolicyRevisionId: "synthetic-stat-r1",
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    executedPosture: posture(),
    observation,
  });
}

function posture(): TcgplayerMarketObservationPosture {
  return {
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
  };
}

function marginals(rows: readonly { providerCondition: string; deliveredAmount: string }[]) {
  return rows
    .map((row) => [row.providerCondition, row.deliveredAmount])
    .sort(
      ([conditionA, amountA], [conditionB, amountB]) =>
        conditionA!.localeCompare(conditionB!) || Number(amountA) - Number(amountB),
    );
}

function scaleFirstThenDedupe(
  rows: readonly { anonymousCaptureSellerOrdinal: number; providerCondition: string; deliveredAmount: string }[],
  multipliers: Readonly<Record<string, number>>,
  target: number,
) {
  return new Set(
    rows
      .filter((row) => Number(row.deliveredAmount) * multipliers[row.providerCondition]! <= target)
      .map((row) => row.anonymousCaptureSellerOrdinal),
  ).size;
}

function storeWinShare(competingSellers: number) {
  return Number((1 / (competingSellers + 1)).toFixed(4));
}

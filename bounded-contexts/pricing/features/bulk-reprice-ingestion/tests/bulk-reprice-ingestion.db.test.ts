import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketplaceInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { createBulkRepriceIngestionRuntime, type BulkRepriceMarketplaceListingGateway } from "../api/runtime";
import { listBulkRepriceRows } from "../read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: 1,
    data,
    timing: { recordedAt },
  } as never;
}

function eventContext(accountId: string) {
  return {
    tenantId: "ten_1" as never,
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: accountId as never,
    },
  } as never;
}

describeDb("pricing bulk reprice ingestion job engine (#4328)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_bulk_reprice");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedListings(pool: PgTransactionalPool) {
    const handlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    const listings = [
      { listingId: "lst_1", inventoryItemId: "inv_1", priceAmount: "10.00" },
      { listingId: "lst_2", inventoryItemId: null, priceAmount: "20.00" },
      { listingId: "lst_3", inventoryItemId: "inv_3", priceAmount: "15.00" },
    ] as const;

    for (const listing of listings) {
      await handlers["marketplace.listing.created"]!(
        event(
          "marketplace.listing.created",
          {
            listingId: listing.listingId,
            accountId: "acc_seller",
            inventoryItemId: listing.inventoryItemId ?? undefined,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            priceAmount: listing.priceAmount,
            quantityCap: 1,
          },
          "2026-07-01T00:00:00.000Z",
          `marketplace.listing-${listing.listingId}`,
        ),
      );
      await handlers["marketplace.listing.published"]!(
        event(
          "marketplace.listing.published",
          {},
          "2026-07-01T00:00:00.000Z",
          `marketplace.listing-${listing.listingId}`,
        ),
      );
    }
  }

  function fakeMarketplaceGateway(): BulkRepriceMarketplaceListingGateway & { calls: number } {
    const gateway = {
      calls: 0,
      applyBulkListingPriceUpdates: async (body: {
        updates: readonly { listingId: string; priceAmount: string }[];
      }) => {
        gateway.calls += 1;
        return {
          items: body.updates.map((update) => ({
            listingId: update.listingId,
            outcome: "applied" as const,
          })),
        };
      },
    };
    return gateway;
  }

  function fakeInventoryGateway() {
    return {
      resolveSellerSkusToInventoryItems: async (sellerSkus: readonly string[]) =>
        sellerSkus.map((sellerSku) => {
          if (sellerSku === "SKU-1") {
            return { sellerSku, status: "mapped" as const, inventoryItemId: "inv_1" };
          }
          if (sellerSku === "SKU-3") {
            return { sellerSku, status: "mapped" as const, inventoryItemId: "inv_3" };
          }
          return { sellerSku, status: "missing" as const };
        }),
    };
  }

  it("diffs rows against the local listing read model, applies only deltas, and reports per-row outcomes", async () => {
    const pool = pools.pricing;
    await seedListings(pool);
    const runtime = createBulkRepriceIngestionRuntime({ db: pool });

    const job = await runtime.enqueueJob(
      {
        accountId: "acc_seller",
        rows: [
          { sellerSku: "SKU-1", newPriceAmount: "12.00" }, // resolves to lst_1 (10.00 -> 12.00): applied
          { listingId: "lst_2", newPriceAmount: "20.00" }, // unchanged
          { sellerSku: "SKU-MISSING", newPriceAmount: "5.00" }, // unresolved sku: failed
          { listingId: "lst_does_not_exist", newPriceAmount: "5.00" }, // not found: failed
          { sellerSku: "SKU-1", newPriceAmount: "1.00" }, // invalid price (< min? still valid money actually) duplicate target of lst_1
          { newPriceAmount: "9.99" }, // missing both sellerSku/listingId: failed at parse time
        ],
        sourceFilename: "test.csv",
      },
      eventContext("acc_seller"),
    );

    expect(job.status).toBe("queued");

    const marketplaceGateway = fakeMarketplaceGateway();
    const processed = await runtime.processNextBulkRepriceJob({
      claimOwnerId: "worker_1",
      claimTtlMs: 30_000,
      marketplaceListingGatewayForAccount: () => marketplaceGateway,
      inventorySkuGatewayForAccount: () => fakeInventoryGateway(),
    });

    expect(processed).toBe(1);

    const completedJob = await runtime.getJob(job.jobId);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.result).toEqual({ applied: 1, unchanged: 1, failed: 4, total: 6 });
    expect(marketplaceGateway.calls).toBe(1);

    const rows = await listBulkRepriceRows(pool, { jobId: job.jobId });
    expect(rows).toHaveLength(6);

    const byOutcome = (outcome: string) => rows.filter((row) => row.outcome === outcome);
    expect(byOutcome("applied")).toHaveLength(1);
    expect(byOutcome("unchanged")).toHaveLength(1);
    expect(byOutcome("failed")).toHaveLength(4);

    const duplicateRow = rows.find((row) => row.row_number === 5);
    expect(duplicateRow?.outcome).toBe("failed");
    expect(duplicateRow?.error_message).toMatch(/already has a price update from an earlier row/);

    const csv = await runtime.getResultsCsv(job.jobId);
    expect(csv.split("\n")).toHaveLength(7); // header + 6 rows
  });

  it("suppresses unchanged rows before ever calling the marketplace gateway", async () => {
    const pool = pools.pricing;
    await seedListings(pool);
    const runtime = createBulkRepriceIngestionRuntime({ db: pool });

    const job = await runtime.enqueueJob(
      {
        accountId: "acc_seller",
        rows: [
          { listingId: "lst_1", newPriceAmount: "10.00" },
          { listingId: "lst_2", newPriceAmount: "20.00" },
          { listingId: "lst_3", newPriceAmount: "15.00" },
        ],
      },
      eventContext("acc_seller"),
    );

    const marketplaceGateway = fakeMarketplaceGateway();
    await runtime.processNextBulkRepriceJob({
      claimOwnerId: "worker_1",
      claimTtlMs: 30_000,
      marketplaceListingGatewayForAccount: () => marketplaceGateway,
      inventorySkuGatewayForAccount: () => fakeInventoryGateway(),
    });

    expect(marketplaceGateway.calls).toBe(0);
    const completedJob = await runtime.getJob(job.jobId);
    expect(completedJob?.result).toEqual({ applied: 0, unchanged: 3, failed: 0, total: 3 });
  });

  it("enforces one active job per account", async () => {
    const pool = pools.pricing;
    await seedListings(pool);
    const runtime = createBulkRepriceIngestionRuntime({ db: pool });

    await runtime.enqueueJob(
      { accountId: "acc_seller", rows: [{ listingId: "lst_1", newPriceAmount: "11.00" }] },
      eventContext("acc_seller"),
    );

    await expect(
      runtime.enqueueJob(
        { accountId: "acc_seller", rows: [{ listingId: "lst_2", newPriceAmount: "21.00" }] },
        eventContext("acc_seller"),
      ),
    ).rejects.toThrow(/already has an active bulk reprice job/);
  });

  it("cancels a queued job so it is never claimed", async () => {
    const pool = pools.pricing;
    await seedListings(pool);
    const runtime = createBulkRepriceIngestionRuntime({ db: pool });

    const job = await runtime.enqueueJob(
      { accountId: "acc_seller", rows: [{ listingId: "lst_1", newPriceAmount: "11.00" }] },
      eventContext("acc_seller"),
    );

    const cancelled = await runtime.cancelJob(job.jobId, "acc_seller");
    expect(cancelled.status).toBe("failed");

    const marketplaceGateway = fakeMarketplaceGateway();
    const processed = await runtime.processNextBulkRepriceJob({
      claimOwnerId: "worker_1",
      claimTtlMs: 30_000,
      marketplaceListingGatewayForAccount: () => marketplaceGateway,
      inventorySkuGatewayForAccount: () => fakeInventoryGateway(),
    });

    expect(processed).toBe(0);
    expect(marketplaceGateway.calls).toBe(0);
  });

  it("rejects an upload with more rows than the policy allows", async () => {
    const pool = pools.pricing;
    const runtime = createBulkRepriceIngestionRuntime({ db: pool });
    const rows = Array.from({ length: 5 }, (_, index) => ({ listingId: `lst_${index}`, newPriceAmount: "1.00" }));

    // The launch default caps at 250k rows -- a tiny policy override proves the guard reads live policy, not a hardcoded constant.
    await pool.query(
      `INSERT INTO platform_policy_documents
         (document_id, policy_key, context_name, schema_summary, status, value, effective_from, effective_until, created_at, updated_at)
       VALUES ('doc_test_cap', 'pricing.bulk-reprice-ingestion', 'pricing', 'test override', 'active', $1::jsonb, now() - interval '1 day', NULL, now(), now())`,
      [
        JSON.stringify({
          enabled: true,
          chunkSize: 200,
          yieldIntervalMs: 0,
          maxActiveJobsPerAccount: 1,
          maxRowsPerUpload: 3,
        }),
      ],
    );

    await expect(runtime.enqueueJob({ accountId: "acc_seller", rows }, eventContext("acc_seller"))).rejects.toThrow(
      /exceeds the 3-row limit/,
    );
  });
});

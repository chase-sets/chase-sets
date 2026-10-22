import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import {
  buildRepricingSourceShareProjectionHandlers,
  listRepricingSourceShareWeeks,
  pricingRepricingSourceShareCheckpointKey,
} from "../read-model/source-share";
import { evaluateBulkRepriceSunset } from "../domain/sunset";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("repricing source-share synthetic matrix", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "repricing_source_share");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function checkpoint(position: string) {
    await pools.pricing.query(
      `INSERT INTO event_subscription_checkpoints (checkpoint_key, last_global_position, updated_at)
      VALUES ($1, $2, '2030-01-01') ON CONFLICT (checkpoint_key) DO UPDATE SET last_global_position = EXCLUDED.last_global_position`,
      [pricingRepricingSourceShareCheckpointKey, position],
    );
    await pools.pricing.query(
      `INSERT INTO event_projection_recovery_markers (projection_kind, projection_key, last_global_position, updated_at)
       VALUES ('subscription', $1, $2, now()) ON CONFLICT (projection_kind, projection_key)
       DO UPDATE SET last_global_position = EXCLUDED.last_global_position`,
      [pricingRepricingSourceShareCheckpointKey, position],
    );
  }

  async function price(
    id: string,
    source: string | undefined,
    accountId = "seller",
    listingId = id,
    position = id.replace(/\D/g, "") || "1",
  ) {
    const handlers = buildRepricingSourceShareProjectionHandlers(pools.pricing);
    await handlers["marketplace.listing.price-updated"]!({
      id,
      streamId: `marketplace.listing-${listingId}`,
      globalPosition: position,
      data: { priceAmount: "10.00", changeSource: source },
      audit: { forAccountId: accountId },
      timing: { occurredAt: "2026-10-07T12:00:00Z", recordedAt: "2026-10-07T12:00:00Z" },
    } as never);
  }

  async function crossWeek(position = "9007199254740993") {
    const handlers = buildRepricingSourceShareProjectionHandlers(pools.pricing, ["marketplace.listing.paused"]);
    await handlers["marketplace.listing.paused"]!({
      globalPosition: position,
      timing: { recordedAt: "2026-10-11T00:00:00Z" },
    } as never);
  }
  const range = { from: "2026-10-04", to: "2026-10-04" };

  it("partitions bulk/policy/manual/unattributed, counts redelivery once, and rebuilds identical replay totals", async () => {
    const project = async () => {
      await price("evt1", "bulk-reprice");
      await price("evt1", "bulk-reprice");
      await price("evt2", "repricing-engine");
      await price("evt3", "seller");
      await price("evt4", undefined);
      await crossWeek();
      await checkpoint("9007199254740993");
    };
    await project();
    const original = await listRepricingSourceShareWeeks(pools.pricing, range);
    expect(original[0]).toMatchObject({
      eventCount: 4,
      counts: { bulk: 1, policy: 1, manual: 1, unattributed: 1 },
      shares: { bulk: 0.25, policy: 0.25, manual: 0.25 },
      status: "incomplete",
      reason: "unattributed-event",
    });
    expect(Object.values(original[0]!.counts).reduce((sum, value) => sum + value, 0)).toBe(original[0]!.eventCount);
    await pools.pricing.query(
      "TRUNCATE pricing_repricing_source_share_events, pricing_repricing_source_share_watermark",
    );
    await project();
    expect(await listRepricingSourceShareWeeks(pools.pricing, range)).toEqual(original);
  });

  it("requires a source watermark and an acknowledged checkpoint, not processing time; complete empty weeks remain zero", async () => {
    await price("evt1", "seller");
    await checkpoint("9007199254740993");
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]).toMatchObject({
      status: "incomplete",
      reason: "checkpoint-lag",
    });
    await crossWeek();
    await checkpoint("9007199254740992");
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]?.status).toBe("incomplete");
    await checkpoint("9007199254740993");
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]?.status).toBe("complete");
    expect(
      (await listRepricingSourceShareWeeks(pools.pricing, { from: "2026-09-27", to: "2026-09-27" }))[0],
    ).toMatchObject({ status: "complete", eventCount: 0, shares: { bulk: 0, policy: 0, manual: 0 } });
  });

  it("fails closed during recovery or while a source stream is quarantined", async () => {
    await price("evt1", "seller");
    await crossWeek();
    await checkpoint("9007199254740993");
    await pools.pricing.query("DELETE FROM event_projection_recovery_markers");
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]?.status).toBe("incomplete");
    await checkpoint("9007199254740993");
    await pools.pricing.query(
      `INSERT INTO event_projection_blocked_streams
       (projection_key, stream_id, first_blocked_global_position, first_blocked_stream_version,
        last_seen_global_position, state, updated_at)
       VALUES ($1, 'marketplace.listing-blocked', 1, 1, 1, 'blocked', now())`,
      [pricingRepricingSourceShareCheckpointKey],
    );
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]?.status).toBe("incomplete");
    await pools.pricing.query("UPDATE event_projection_blocked_streams SET state = 'resolved'");
    expect((await listRepricingSourceShareWeeks(pools.pricing, range))[0]?.status).toBe("complete");
  });

  it("checks reliance beyond the displayed 50 sellers and counts distinct listings", async () => {
    for (let index = 1; index <= 50; index++) await price(`evt${index}`, "bulk-reprice", `small-${index}`, "one");
    await price("evt51", "bulk-reprice", "reliant", "one");
    await price("evt52", "bulk-reprice", "reliant", "two");
    await price("evt53", "seller", "reliant", "three");
    await crossWeek();
    await checkpoint("9007199254740993");
    const weeks = await listRepricingSourceShareWeeks(pools.pricing, { ...range, sellerAccountId: "reliant" });
    expect(weeks[0]?.topSellers).toHaveLength(50);
    expect(weeks[0]?.topSellers.some((seller) => seller.accountId === "reliant")).toBe(false);
    expect(weeks[0]?.requestedSeller).toMatchObject({ bulkListingCount: 2, bulkCount: 2, manualCount: 1 });
    expect(
      evaluateBulkRepriceSunset(
        weeks,
        { maxBulkSharePercent: 100, consecutiveCompleteWeeks: 1, relianceListingThreshold: 1 },
        true,
        "2026-10-11T00:00:00Z",
      ),
    ).toEqual({ status: "ineligible", reasons: ["2026-10-04:bulk-reliance"] });
    const plan = await pools.pricing.query(
      "EXPLAIN (FORMAT JSON) SELECT * FROM pricing_repricing_source_share_events WHERE week_start = '2026-10-04' AND seller_account_id = 'reliant'",
    );
    expect(plan.rows).toHaveLength(1);
    const indexes = await pools.pricing.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'pricing_repricing_source_share_week_seller_idx'",
    );
    expect(indexes.rows[0]?.indexdef).toContain("(week_start, seller_account_id)");
  });
});

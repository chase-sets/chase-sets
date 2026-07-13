import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { listDueSellerAvailabilityRestores } from "../read-model/queries";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;

function context(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_test" as never,
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: accountId as never,
    },
  };
}

describeDb("marketplace seller-availability auto-resume sweep SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_seller_availability_sweep",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function buildServices(pool: PgTransactionalPool) {
    return createMarketplaceServices(pool);
  }

  async function readAvailabilityRow(pool: PgTransactionalPool, accountId: string) {
    const result = await pool.query<{
      status: string;
      available_again_at: string | null;
      disabled_reason_category: string | null;
    }>(
      `SELECT status, available_again_at::text AS available_again_at, disabled_reason_category
       FROM marketplace_seller_listing_availability_pages
       WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  // The seller-listing-availability read model is populated by an async
  // subscription (marketplace.self-listing-projection), not synchronously by
  // the command handler. This harness has no subscription runner draining
  // that queue, so tests that assert against the read model must replay the
  // account's own event stream through the real projection handlers -- an
  // idempotent no-op catch-up, mirroring how
  // review-eligibility-sql.db.test.ts drives its projections directly.
  async function catchUpAvailabilityProjection(pool: PgTransactionalPool, accountId: string): Promise<void> {
    const eventStore = createPostgresEventStore({ pool });
    const events = await eventStore.readStream({
      streamId: `marketplace.seller-listing-availability-${accountId}`,
    });
    const handlers = buildMarketplaceListingProjectionHandlers(pool);

    for (const storedEvent of events) {
      const transportEvent = toTransportEvent(storedEvent);
      const handler = handlers[transportEvent.type];
      if (handler) {
        await handler(transportEvent);
      }
    }
  }

  it("restores a due account, is idempotent on re-sweep, and never surfaces a legacy availableAgainOn-only row", async () => {
    const pool = pools.marketplace;
    const services = buildServices(pool);

    // Due: an authoritative resume instant in the past.
    await services.listings.disableSellerListingAvailability(
      {
        accountId: "acc_away_due",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-07-01T00:00:00.000Z",
      },
      context("acc_away_due"),
    );
    await catchUpAvailabilityProjection(pool, "acc_away_due");

    // Not due: an authoritative resume instant in the future.
    await services.listings.disableSellerListingAvailability(
      {
        accountId: "acc_away_not_yet",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-12-01T00:00:00.000Z",
      },
      context("acc_away_not_yet"),
    );
    await catchUpAvailabilityProjection(pool, "acc_away_not_yet");

    // Legacy shape: unavailable with only a display-only availableAgainOn
    // date, no availableAgainAt at all. This never participates in
    // automated resume regardless of how stale the date is.
    await pool.query(
      `INSERT INTO marketplace_seller_listing_availability_pages (
         account_id, status, disabled_reason_category, available_again_on, available_again_at, disabled_at, updated_at
       ) VALUES ('acc_away_legacy', 'unavailable', 'travel', '2020-01-01', NULL, '2020-01-01T00:00:00.000Z', now())`,
    );

    const now = "2026-07-13T12:00:00.000Z";
    const due = await listDueSellerAvailabilityRestores(pool, { now });
    expect(due.map((row) => row.account_id)).toEqual(["acc_away_due"]);

    const firstSweep = await services.listings.sweepDueSellerAvailabilityRestores({ now }, context("system"));
    expect(firstSweep).toEqual({ checked: 1, restored: 1, skipped: 0 });
    await catchUpAvailabilityProjection(pool, "acc_away_due");

    const restoredRow = await readAvailabilityRow(pool, "acc_away_due");
    expect(restoredRow).toMatchObject({ status: "available", available_again_at: null });

    const untouchedRow = await readAvailabilityRow(pool, "acc_away_not_yet");
    expect(untouchedRow).toMatchObject({ status: "unavailable" });

    const legacyRow = await readAvailabilityRow(pool, "acc_away_legacy");
    expect(legacyRow).toMatchObject({ status: "unavailable" });

    // Re-sweep after restore finds nothing: idempotent.
    const secondSweep = await services.listings.sweepDueSellerAvailabilityRestores({ now }, context("system"));
    expect(secondSweep).toEqual({ checked: 0, restored: 0, skipped: 0 });
  });

  it("clamps the batch limit and processes the most-overdue accounts first", async () => {
    const pool = pools.marketplace;
    const services = buildServices(pool);

    await services.listings.disableSellerListingAvailability(
      {
        accountId: "acc_away_earliest",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-06-01T00:00:00.000Z",
      },
      context("acc_away_earliest"),
    );
    await catchUpAvailabilityProjection(pool, "acc_away_earliest");
    await services.listings.disableSellerListingAvailability(
      {
        accountId: "acc_away_middle",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-06-15T00:00:00.000Z",
      },
      context("acc_away_middle"),
    );
    await catchUpAvailabilityProjection(pool, "acc_away_middle");
    await services.listings.disableSellerListingAvailability(
      {
        accountId: "acc_away_latest",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-07-01T00:00:00.000Z",
      },
      context("acc_away_latest"),
    );
    await catchUpAvailabilityProjection(pool, "acc_away_latest");

    const now = "2026-07-13T12:00:00.000Z";
    const sweep = await services.listings.sweepDueSellerAvailabilityRestores({ now, limit: 1 }, context("system"));
    expect(sweep).toEqual({ checked: 1, restored: 1, skipped: 0 });
    await catchUpAvailabilityProjection(pool, "acc_away_earliest");

    // Only the longest-overdue account was restored this pass.
    expect(await readAvailabilityRow(pool, "acc_away_earliest")).toMatchObject({ status: "available" });
    expect(await readAvailabilityRow(pool, "acc_away_middle")).toMatchObject({ status: "unavailable" });
    expect(await readAvailabilityRow(pool, "acc_away_latest")).toMatchObject({ status: "unavailable" });

    // The scheduled runner's interval cadence drains the remainder on
    // subsequent passes.
    const secondSweep = await services.listings.sweepDueSellerAvailabilityRestores(
      { now, limit: 1 },
      context("system"),
    );
    expect(secondSweep).toEqual({ checked: 1, restored: 1, skipped: 0 });
    await catchUpAvailabilityProjection(pool, "acc_away_middle");
    expect(await readAvailabilityRow(pool, "acc_away_middle")).toMatchObject({ status: "available" });
  });

  it("no-ops a scheduled enable, without a duplicate .enabled fact, when the seller pushes the resume instant forward after the sweep observed it due (lost race)", async () => {
    const pool = pools.marketplace;
    const services = buildServices(pool);
    const accountId = "acc_away_race";

    await services.listings.disableSellerListingAvailability(
      {
        accountId,
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-07-01T00:00:00.000Z",
      },
      context(accountId),
    );
    await catchUpAvailabilityProjection(pool, accountId);

    const now = "2026-07-13T12:00:00.000Z";
    // The sweep's due-query observes the account as due and captures its
    // Resume Instant as `dueBy`.
    const due = await listDueSellerAvailabilityRestores(pool, { now });
    expect(due).toHaveLength(1);
    const staleDueBy = due[0]!.available_again_at;

    // Before the sweep's command reaches the aggregate, the seller extends
    // their away period -- a concurrent, later-landing action.
    await services.listings.disableSellerListingAvailability(
      {
        accountId,
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-08-01T00:00:00.000Z",
      },
      context(accountId),
    );
    await catchUpAvailabilityProjection(pool, accountId);

    // The sweep now issues its enable using the stale `dueBy` it captured
    // above -- this must no-op, not clobber the seller's extension.
    await services.listings.enableSellerListingAvailability(
      { accountId, enabledBy: "scheduled", dueBy: staleDueBy },
      context("system"),
    );

    const row = await readAvailabilityRow(pool, accountId);
    expect(row).toMatchObject({ status: "unavailable", available_again_at: "2026-08-01T00:00:00.000Z" });

    // No duplicate `.enabled` fact landed on the stream.
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version ASC`,
      [`marketplace.seller-listing-availability-${accountId}`],
    );
    expect(events.rows.map((eventRow) => eventRow.event_type)).toEqual([
      "marketplace.seller-listing-availability.disabled",
      "marketplace.seller-listing-availability.disabled",
    ]);
  });
});

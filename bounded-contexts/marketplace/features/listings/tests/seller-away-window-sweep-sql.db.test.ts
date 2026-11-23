import { listingTestCommand } from "./listing-attempt-test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BcApiEntry, BcApiModule } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase, drainContextRuntime } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import type { MarketplaceServices } from "../../../support/runtime-support/services";
import { listDueSellerAwayWindowStarts } from "../read-model/queries";
import { buildMarketplaceSettlementNegativeBalanceProjectionHandlers } from "../integrations/settlement/negative-balance-projection";

const NO_API_ENTRIES: readonly BcApiEntry[] = [];

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
// Marketplace's own manifest declares cross-context event subscriptions
// alongside its "self" subscription that feeds the seller listing
// availability read model. None of those
// cross-context sources publish events this test cares about, but the
// runtime still validates every declared source context is mounted, so
// they ride along as source-only placeholders.
const contextNames = [
  "marketplace",
  "catalog",
  "identity",
  "inventory",
  "ordering",
  "fulfillment",
  "platform-operations",
  "settlement",
  "pricing",
  "payments",
] as const;

function sourceOnlyModule(contextName: string, streamPrefix: string) {
  return {
    contextName,
    routePrefix: `/api/${contextName}`,
    streamPrefix,
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({}),
    buildApis: () => NO_API_ENTRIES,
  } satisfies BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>>;
}

const catalogSourceModule = sourceOnlyModule("catalog", "catalog.");
const identitySourceModule = sourceOnlyModule("identity", "identity.");
const inventorySourceModule = sourceOnlyModule("inventory", "inventory.");
const orderingSourceModule = sourceOnlyModule("ordering", "ordering.");
const fulfillmentSourceModule = sourceOnlyModule("fulfillment", "fulfillment.");
const platformOperationsSourceModule = sourceOnlyModule("platform-operations", "platform-operations.");
const settlementSourceModule = sourceOnlyModule("settlement", "settlement.");
const pricingSourceModule = sourceOnlyModule("pricing", "pricing.");
const paymentsSourceModule = sourceOnlyModule("payments", "payments.");

function context(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_test" as never,
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: accountId as never,
    },
  };
}

describeDb("marketplace seller away-window start sweep SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_seller_away_window_sweep",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    // Every mounted context's own pool needs the shared event-store +
    // subscription-checkpoint schema, even the source-only placeholders --
    // the subscription runner reads each source context's event stream
    // from that context's own pool.
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await bootstrapContextDatabase(catalogSourceModule, pools.catalog);
    await bootstrapContextDatabase(identitySourceModule, pools.identity);
    await bootstrapContextDatabase(inventorySourceModule, pools.inventory);
    await bootstrapContextDatabase(orderingSourceModule, pools.ordering);
    await bootstrapContextDatabase(fulfillmentSourceModule, pools.fulfillment);
    await bootstrapContextDatabase(platformOperationsSourceModule, pools["platform-operations"]);
    await bootstrapContextDatabase(settlementSourceModule, pools.settlement);
    await bootstrapContextDatabase(pricingSourceModule, pools.pricing);
    await bootstrapContextDatabase(paymentsSourceModule, pools.payments);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  // Commands append to the event store; the seller listing availability
  // read model is populated by marketplace's own "self" projection
  // subscription, which only advances when drained -- mirrors the wake +
  // catch-up runner the platform-worker drives in production.
  function buildRuntime() {
    const runtime = createMountedContextTestRuntime([
      { contextName: "marketplace", module: marketplaceModule, pool: pools.marketplace, ports: {} },
      { contextName: "catalog", mountRole: "source-only", module: catalogSourceModule, pool: pools.catalog, ports: {} },
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identitySourceModule,
        pool: pools.identity,
        ports: {},
      },
      {
        contextName: "inventory",
        mountRole: "source-only",
        module: inventorySourceModule,
        pool: pools.inventory,
        ports: {},
      },
      {
        contextName: "ordering",
        mountRole: "source-only",
        module: orderingSourceModule,
        pool: pools.ordering,
        ports: {},
      },
      {
        contextName: "fulfillment",
        mountRole: "source-only",
        module: fulfillmentSourceModule,
        pool: pools.fulfillment,
        ports: {},
      },
      {
        contextName: "platform-operations",
        mountRole: "source-only",
        module: platformOperationsSourceModule,
        pool: pools["platform-operations"],
        ports: {},
      },
      {
        contextName: "settlement",
        mountRole: "source-only",
        module: settlementSourceModule,
        pool: pools.settlement,
        ports: {},
      },
      {
        contextName: "pricing",
        mountRole: "source-only",
        module: pricingSourceModule,
        pool: pools.pricing,
        ports: {},
      },
      {
        contextName: "payments",
        mountRole: "source-only",
        module: paymentsSourceModule,
        pool: pools.payments,
        ports: {},
      },
    ]);
    return { runtime, services: runtime.services.marketplace as MarketplaceServices };
  }

  async function readAvailabilityRow(pool: PgTransactionalPool, accountId: string) {
    const result = await pool.query<{
      status: string;
      available_again_at: string | null;
      disabled_reason_category: string | null;
      away_window_starts_at: string | null;
      away_window_ends_at: string | null;
      away_window_reason_category: string | null;
    }>(
      `SELECT
         status,
         available_again_at::text AS available_again_at,
         disabled_reason_category,
         away_window_starts_at::text AS away_window_starts_at,
         away_window_ends_at::text AS away_window_ends_at,
         away_window_reason_category
       FROM marketplace_seller_listing_availability_pages
       WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  it("starts both sides once and restores both at the same Resume Instant", async () => {
    const { runtime, services } = buildRuntime();
    const accountId = "acc_both";
    const startsAt = "2030-01-01T00:00:00.000Z";
    const endsAt = "2030-01-10T00:00:00.000Z";
    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt,
        endsAt,
        reasonCategory: "travel",
        scope: "both",
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);
    expect(await services.listings.sweepDueSellerAwayWindowStarts({ now: startsAt }, context("system"))).toEqual({
      checked: 1,
      started: 1,
      skipped: 0,
    });
    await drainContextRuntime(runtime);
    const away = await services.listings.getSellerListingAvailability(accountId);
    expect(away).toMatchObject({ status: "unavailable", offers_status: "unavailable", away_window_starts_at: null });
    expect(new Date(away.offers_available_again_at!).toISOString()).toBe(endsAt);
    expect(
      await services.listings.sweepDueSellerAvailabilityRestores(
        { now: "2030-01-09T23:59:59.999Z" },
        context("system"),
      ),
    ).toEqual({
      checked: 0,
      restored: 0,
      skipped: 0,
    });
    expect(await services.listings.sweepDueSellerAvailabilityRestores({ now: endsAt }, context("system"))).toEqual({
      checked: 2,
      restored: 2,
      skipped: 0,
    });
    await drainContextRuntime(runtime);
    expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
      status: "available",
      offers_status: "available",
      offers_available_again_at: null,
    });
    expect(await services.listings.sweepDueSellerAwayWindowStarts({ now: endsAt }, context("system"))).toEqual({
      checked: 0,
      started: 0,
      skipped: 0,
    });
  });

  it.each(["offers", "both"] as const)(
    "starts and restores the Offers leg of a pending %s window without releasing the settlement Listings disable",
    async (scope) => {
      const { runtime, services } = buildRuntime();
      const accountId = "acc_settlement";
      const startsAt = "2030-01-01T00:00:00.000Z";
      const endsAt = "2030-01-10T00:00:00.000Z";
      await services.listings.scheduleSellerAwayWindow(
        listingTestCommand("seller.away", {
          action: "schedule",
          accountId,
          startsAt,
          endsAt,
          reasonCategory: "travel",
          scope,
        }),
        context(accountId),
      );
      await drainContextRuntime(runtime);

      const type = "settlement.wallet.negative-balance-collections-opened";
      await buildMarketplaceSettlementNegativeBalanceProjectionHandlers(services.listings)[type]!(
        buildTransportEvent(type, { accountId }),
      );
      await drainContextRuntime(runtime);
      expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
        status: "unavailable",
        offers_status: "available",
        away_window_scope: "offers",
      });
      expect(await services.listings.sweepDueSellerAwayWindowStarts({ now: startsAt }, context("system"))).toEqual({
        checked: 1,
        started: 1,
        skipped: 0,
      });
      await drainContextRuntime(runtime);
      expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
        status: "unavailable",
        offers_status: "unavailable",
        away_window_starts_at: null,
      });
      expect(await services.listings.sweepDueSellerAvailabilityRestores({ now: endsAt }, context("system"))).toEqual({
        checked: 1,
        restored: 1,
        skipped: 0,
      });
      await drainContextRuntime(runtime);
      expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
        status: "unavailable",
        disabled_reason_category: "operations",
        available_again_at: null,
        offers_status: "available",
      });
    },
  );

  it("restores Offers-only at the retained deadline after narrowing from both", async () => {
    const { runtime, services } = buildRuntime();
    const accountId = "acc_narrowed";
    const resume = "2030-01-10T00:00:00.000Z";
    for (const scope of ["both", "offers"] as const) {
      await services.listings.disableSellerListingAvailability(
        listingTestCommand("seller.availability", {
          accountId,
          status: "unavailable",
          scope,
          reasonCategory: "travel",
          availableAgainOn: null,
          availableAgainAt: scope === "both" ? resume : null,
        }),
        context(accountId),
      );
    }
    await drainContextRuntime(runtime);
    expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
      status: "available",
      offers_status: "unavailable",
    });
    expect(await services.listings.sweepDueSellerAvailabilityRestores({ now: resume }, context("system"))).toEqual({
      checked: 1,
      restored: 1,
      skipped: 0,
    });
    await drainContextRuntime(runtime);
    expect(await services.listings.getSellerListingAvailability(accountId)).toMatchObject({
      status: "available",
      offers_status: "available",
    });
  });

  it("skips a due Offers restore when the seller has already moved its deadline", async () => {
    const { runtime, services } = buildRuntime();
    const accountId = "acc_offers_restore_race";
    const firstDeadline = "2030-01-10T00:00:00.000Z";
    const movedDeadline = "2030-01-11T00:00:00.000Z";
    const disable = (availableAgainAt: string) =>
      services.listings.disableSellerListingAvailability(
        listingTestCommand("seller.availability", {
          accountId,
          status: "unavailable",
          scope: "offers",
          reasonCategory: "travel",
          availableAgainOn: null,
          availableAgainAt,
        }),
        context(accountId),
      );
    await disable(firstDeadline);
    await drainContextRuntime(runtime);
    await disable(movedDeadline);
    expect(
      await services.listings.sweepDueSellerAvailabilityRestores({ now: firstDeadline }, context("system")),
    ).toEqual({ checked: 1, restored: 0, skipped: 1 });
    await drainContextRuntime(runtime);
    const stillAway = await services.listings.getSellerListingAvailability(accountId);
    expect(stillAway.offers_status).toBe("unavailable");
    expect(new Date(stillAway.offers_available_again_at!).toISOString()).toBe(movedDeadline);
  });

  it("full round trip: schedule -> start sweep disables with the window's Resume Instant -> restore sweep re-enables with scheduled provenance", async () => {
    const pool = pools.marketplace;
    const { runtime, services } = buildRuntime();
    const accountId = "acc_away_window_round_trip";

    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: "2030-01-10T00:00:00.000Z",
        reasonCategory: "travel",
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);

    const startNow = "2030-01-15T00:00:00.000Z";
    const dueStarts = await listDueSellerAwayWindowStarts(pool, { now: startNow });
    expect(dueStarts.map((row) => row.account_id)).toEqual([accountId]);

    const startSweep = await services.listings.sweepDueSellerAwayWindowStarts({ now: startNow }, context("system"));
    expect(startSweep).toEqual({ checked: 1, started: 1, skipped: 0 });
    await drainContextRuntime(runtime);

    const afterStart = await readAvailabilityRow(pool, accountId);
    // Postgres's timestamptz::text format never byte-matches an ISO-8601
    // string, even for the same instant.
    expect(new Date(afterStart?.available_again_at ?? "").toISOString()).toBe("2030-01-10T00:00:00.000Z");
    expect(afterStart).toMatchObject({
      status: "unavailable",
      disabled_reason_category: "travel",
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
    });

    // The end boundary rides the existing Resume Instant sweep -- no
    // separate "end sweep" exists for Away Windows.
    const restoreSweep = await services.listings.sweepDueSellerAvailabilityRestores(
      { now: startNow },
      context("system"),
    );
    expect(restoreSweep).toEqual({ checked: 1, restored: 1, skipped: 0 });
    await drainContextRuntime(runtime);

    const afterRestore = await readAvailabilityRow(pool, accountId);
    expect(afterRestore).toMatchObject({ status: "available" });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version ASC`,
      [`marketplace.seller-listing-availability-${accountId}`],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "marketplace.seller-listing-availability.away-window-scheduled",
      "marketplace.seller-listing-availability.disabled",
      "marketplace.seller-listing-availability.enabled",
    ]);
  });

  it("indefinite window (no endsAt) goes away and stays away after the start sweep", async () => {
    const pool = pools.marketplace;
    const { runtime, services } = buildRuntime();
    const accountId = "acc_away_window_indefinite";

    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: null,
        reasonCategory: "other",
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);

    const now = "2030-01-15T00:00:00.000Z";
    const startSweep = await services.listings.sweepDueSellerAwayWindowStarts({ now }, context("system"));
    expect(startSweep).toEqual({ checked: 1, started: 1, skipped: 0 });
    await drainContextRuntime(runtime);

    const afterStart = await readAvailabilityRow(pool, accountId);
    expect(afterStart).toMatchObject({ status: "unavailable", available_again_at: null });

    // No Resume Instant means the restore sweep never picks this account up.
    const restoreSweep = await services.listings.sweepDueSellerAvailabilityRestores({ now }, context("system"));
    expect(restoreSweep).toEqual({ checked: 0, restored: 0, skipped: 0 });

    const stillAway = await readAvailabilityRow(pool, accountId);
    expect(stillAway).toMatchObject({ status: "unavailable" });
  });

  it("race: cancelling the window between the sweep's read and its command skips the disable", async () => {
    const pool = pools.marketplace;
    const { runtime, services } = buildRuntime();
    const accountId = "acc_away_window_cancel_race";

    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: "2030-01-10T00:00:00.000Z",
        reasonCategory: "travel",
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);

    const now = "2030-01-15T00:00:00.000Z";
    // The sweep's due-query observes the window as due.
    const due = await listDueSellerAwayWindowStarts(pool, { now });
    expect(due).toHaveLength(1);

    // Before the sweep's disable command reaches the aggregate, the seller
    // cancels the window.
    await services.listings.cancelScheduledAwayWindow(
      listingTestCommand("seller.away", { action: "cancel", accountId }),
      context(accountId),
    );

    const sweep = await services.listings.sweepDueSellerAwayWindowStarts({ now }, context("system"));
    expect(sweep).toEqual({ checked: 1, started: 0, skipped: 1 });
    await drainContextRuntime(runtime);

    const row = await readAvailabilityRow(pool, accountId);
    expect(row).toMatchObject({ status: "available", away_window_starts_at: null });
  });

  it("a manual disable while a window is pending cancels the window (one source of away-state truth)", async () => {
    const pool = pools.marketplace;
    const { runtime, services } = buildRuntime();
    const accountId = "acc_away_window_manual_preempt";

    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-02-01T00:00:00.000Z",
        endsAt: "2030-02-10T00:00:00.000Z",
        reasonCategory: "travel",
      }),
      context(accountId),
    );

    await services.listings.disableSellerListingAvailability(
      listingTestCommand("seller.availability", {
        status: "unavailable",
        accountId,
        reasonCategory: "audit",
        availableAgainOn: null,
        availableAgainAt: null,
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);

    const row = await readAvailabilityRow(pool, accountId);
    expect(row).toMatchObject({
      status: "unavailable",
      disabled_reason_category: "audit",
      away_window_starts_at: null,
    });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version ASC`,
      [`marketplace.seller-listing-availability-${accountId}`],
    );
    expect(events.rows.map((eventRow) => eventRow.event_type)).toEqual([
      "marketplace.seller-listing-availability.away-window-scheduled",
      "marketplace.seller-listing-availability.disabled",
      "marketplace.seller-listing-availability.away-window-cancelled",
    ]);

    // The now-cancelled window is not due for anything on a later sweep.
    const startSweep = await services.listings.sweepDueSellerAwayWindowStarts(
      { now: "2030-03-01T00:00:00.000Z" },
      context("system"),
    );
    expect(startSweep).toEqual({ checked: 0, started: 0, skipped: 0 });
  });

  it("enforces the one-window invariant and the cancel endpoint end-to-end", async () => {
    const pool = pools.marketplace;
    const { runtime, services } = buildRuntime();
    const accountId = "acc_away_window_reschedule";

    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-02-01T00:00:00.000Z",
        endsAt: null,
        reasonCategory: "travel",
      }),
      context(accountId),
    );

    await expect(
      services.listings.scheduleSellerAwayWindow(
        listingTestCommand("seller.away", {
          action: "schedule",
          accountId,
          startsAt: "2030-03-01T00:00:00.000Z",
          endsAt: null,
          reasonCategory: "audit",
        }),
        context(accountId),
      ),
    ).rejects.toThrow("Cancel the existing scheduled away window before scheduling a new one.");

    await services.listings.cancelScheduledAwayWindow(
      listingTestCommand("seller.away", { action: "cancel", accountId }),
      context(accountId),
    );
    await drainContextRuntime(runtime);
    const afterCancel = await readAvailabilityRow(pool, accountId);
    expect(afterCancel).toMatchObject({ away_window_starts_at: null });

    // Rescheduling now succeeds.
    await services.listings.scheduleSellerAwayWindow(
      listingTestCommand("seller.away", {
        action: "schedule",
        accountId,
        startsAt: "2030-03-01T00:00:00.000Z",
        endsAt: null,
        reasonCategory: "audit",
      }),
      context(accountId),
    );
    await drainContextRuntime(runtime);
    const rescheduled = await readAvailabilityRow(pool, accountId);
    // Postgres's own timestamptz::text format ("2030-03-01 00:00:00+00")
    // never byte-matches an ISO-8601 string even for the same instant, so
    // this compares parsed values.
    expect(new Date(rescheduled?.away_window_starts_at ?? "").toISOString()).toBe("2030-03-01T00:00:00.000Z");
    expect(rescheduled).toMatchObject({ away_window_reason_category: "audit" });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as inventoryModule } from "@chase-sets/inventory";
import type { RequestTerminalBinding } from "@chase-sets/event-core/owner-stream-reservation";
import {
  createPostgresEventStore,
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  ownerPredicateKey,
  withConfigurationEpochTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { evaluationDigest, type EvaluationBinding } from "../domain/evaluation-authority";
import { evaluationOwnerIdentity } from "./evaluation-owner-inputs";
import { reserveDailyChangesInTransaction } from "../read-model/daily-change-budget";
import { dryRunBody, dryRunContext } from "../tests/dry-run-fixture";
import { recordProductRoundDirection } from "../read-model/product-round-state";
import { repricingEnginePolicy } from "../domain/policy";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseUrl ? describe : describe.skip;
const names = ["pricing", "marketplace", "inventory", "catalog"] as const;
const accountId = "acc_exact_synthetic";
const catalogItemId = "cat_exact_synthetic";
const productId = `${catalogItemId}::`;
const categoryId = "ctg_synthetic_exact";
const context = { ...dryRunContext, audit: { ...dryRunContext.audit, forAccountId: accountId } } as const;

describeDb("Pricing Evaluated Decision with separate owner stores", () => {
  let pools: Readonly<Record<(typeof names)[number], PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, names, "synthetic_evaluated_decision");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    for (const [name, pool] of Object.entries(pools))
      await pool.query(name === "inventory" ? inventoryModule.schemaSql : pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function fixture(ownScope = dryRunBody.scope, maxChangesPerDay = 1) {
    const identity = await evaluationOwnerIdentity(pools.marketplace, "marketplace");
    const ports = {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
      pricingEvaluationOwners: pools,
      pricingEvaluationConsumers: [{ identity, pool: pools.marketplace }],
      pricingPredicateConsumerPool: pools.marketplace,
    };
    const services = pricingModule.createServices(pools.pricing, ports);
    async function install(sellerAccountId: `acc_${string}`, scope = dryRunBody.scope) {
      const sellerContext = { ...context, audit: { ...context.audit, forAccountId: sellerAccountId } };
      const run = await services.repricingEngine.enqueueDryRun(
        {
          sellerAccountId,
          body: { ...dryRunBody, scope, maxChangesPerDay },
        },
        sellerContext,
      );
      expect(
        await services.repricingEngine.processNextDryRunJob({ claimOwnerId: "synthetic-exact", claimTtlMs: 30_000 }),
      ).toBe(1);
      expect(
        await services.repricingPolicies.activateRepricingPolicy(
          {
            accountId: sellerAccountId,
            dryRunId: run!.dryRunId,
            name: "Synthetic exact",
          },
          sellerContext,
        ),
      ).toMatchObject({ status: "applied" });
    }
    await install(accountId, ownScope);
    const market = createPostgresEventStore({ pool: pools.marketplace });
    const inventory = inventoryModule.createServices(pools.inventory, {
      stockReservationConsumerPool: pools.marketplace,
    });
    const storageLocationId = "loc_synthetic_exact";
    await inventory.storageLocations.commandHandler({
      streamId: `inventory.storage-location-${storageLocationId}`,
      context,
      command: {
        type: "CreateStorageLocation",
        storageLocationId,
        accountId,
        name: "Synthetic stock",
        shipFromCode: "60601",
        shipFromAddress: {
          name: "Synthetic",
          company: null,
          line1: "1 Main St",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          phone: null,
          email: null,
        },
      },
    });
    const catalog = createPostgresEventStore({ pool: pools.catalog });
    const createCatalogItem = (item: `cat_${string}`) =>
      catalog.appendToStream({
        streamId: `catalog.item-${item}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "catalog.catalog-item.created", payload: { catalogItemId: item } }],
      });
    await createCatalogItem(catalogItemId);
    async function request(suffix: string, consumer = identity, item: `cat_${string}` = catalogItemId) {
      const product = `${item}::` as const;
      const listingId = `lst_synthetic_${suffix}`;
      const inventoryItemId = `inv_synthetic_${suffix}` as const;
      const listingEvents = await market.appendToStream({
        streamId: `marketplace.listing-${listingId}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "marketplace.listing.created", payload: { listingId, accountId } }],
      });
      await inventory.items.commandHandler({
        streamId: `inventory.item-${inventoryItemId}`,
        context,
        command: {
          type: "CreateInventoryItem",
          itemId: inventoryItemId,
          accountId,
          catalogItemId: item,
          productId: product,
          selectedOptions: [],
          storageLocationId,
          totalQuantity: 2,
          acquisitionOccurrence: { kind: "unknown" },
          commandOccurredAt: new Date().toISOString(),
        },
      });
      await inventory.channelStockAllocations.set(
        {
          accountId,
          inventoryItemId,
          mode: "shared-pool",
          partitions: [],
          expectedRevision: 0,
        },
        context,
      );
      const binding: EvaluationBinding = {
        requestId: evaluationDigest(["request", suffix]),
        commandFingerprint: evaluationDigest(["command", suffix]),
        consumer,
        accountId,
        tenantId: context.tenantId,
        principal: {
          userId: context.audit.performedByUserId,
          membershipId: "mbr_synthetic",
          sessionId: "ses_synthetic",
        },
        catalogItemId: item,
        productId: product,
        listingId,
        listingVersion: 1,
        target: { kind: "channel-connection", connectionId: "synthetic" },
        priceAmount: "15.00",
        priceCurrencyCode: "USD",
        decision: {
          kind: "pricing-evaluation",
          evaluationId: `evd_synthetic_${suffix}`,
          evaluationRevision: "1",
          standingAuthorizationId: `repricing-account/${accountId}`,
          standingAuthorizationRevision: "1",
          basePriceRevision: 1,
        },
      };
      const listing = {
        inventoryItemId,
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        basePriceRevision: 1,
        createdAt: new Date(listingEvents[0]!.recordedAt).toISOString(),
        grading: "raw" as const,
        selectedOptions: [],
      };
      return { binding, listing };
    }
    const authority = services.evaluationAuthority!;
    const charges = async () =>
      (
        await pools.pricing.query<{ changes_reserved: number }>(
          "SELECT changes_reserved FROM pricing_repricing_daily_change_budgets",
        )
      ).rows[0]?.changes_reserved;
    const status = async () =>
      (
        await pools.pricing.query<{ status: string }>(
          "SELECT status FROM pricing_evaluated_decisions ORDER BY request_id",
        )
      ).rows.map(({ status }) => status);
    const restart = () => pricingModule.createServices(pools.pricing, ports).evaluationAuthority!;
    return { request, authority, market, charges, status, identity, restart, install, catalog, createCatalogItem };
  }

  it("prepares both promises atomically, shares the worker cap and refunds only known ABORTED", async () => {
    const f = await fixture();
    const first = await f.request("first");
    const prepared = await f.authority.prepare(first.binding, first.listing, context);
    expect(prepared.terminal.reservations.map(({ purpose }) => purpose)).toEqual(
      expect.arrayContaining(["pricing-evaluated-decision", "pricing-daily-change-budget"]),
    );
    expect(await f.charges()).toBe(1);
    const day = prepared.terminal.preparationNotBefore!.slice(0, 10);
    expect(
      await withConfigurationEpochTransaction(pools.pricing, (db) =>
        reserveDailyChangesInTransaction(db, accountId, day, 1, 1),
      ),
    ).toBe(0);
    const later = await f.request("later");
    await expect(f.authority.prepare(later.binding, later.listing, context)).rejects.toThrow("budget is exhausted");
    expect(await f.status()).toEqual(["PREPARED"]);
    await f.authority.settle(first.binding.requestId, first.binding.commandFingerprint, true);
    expect(await f.status()).toEqual(["ABORTED"]);
    expect(await f.charges()).toBe(0);
    await expect(f.authority.prepare(later.binding, later.listing, context)).resolves.toBeDefined();
  });

  it("uses consumer DB time and refuses a foreign incarnation without durable decision authority", async () => {
    const f = await fixture();
    const bad = await f.request("foreign", { ...f.identity, incarnation: "synthetic-foreign" });
    await expect(f.authority.prepare(bad.binding, bad.listing, context)).rejects.toThrow();
    expect(await f.status()).toEqual([]);
    const good = await f.request("time");
    const result = await f.authority.prepare(good.binding, good.listing, context);
    const now = (
      await pools.marketplace.query<{ stamp: Date }>("SELECT clock_timestamp() AS stamp")
    ).rows[0]!.stamp.getTime();
    expect(Date.parse(result.terminal.preparationNotBefore!)).toBeLessThanOrEqual(now);
    expect(
      Date.parse(result.terminal.preparationDeadline) - Date.parse(result.terminal.preparationNotBefore!),
    ).toBeLessThanOrEqual(60_000);
    await expect(
      f.authority.prepare({ ...good.binding, commandFingerprint: "f".repeat(64) }, good.listing, context),
    ).rejects.toThrow("another command");
  });

  it("keeps a prepared charge when original-terminal lookup is unknown and never creates a cohort guard", async () => {
    const f = await fixture();
    const request = await f.request("unknown");
    const original = (await f.authority.prepare(request.binding, request.listing, context)).terminal;
    await pools.marketplace.query("DELETE FROM event_request_terminals WHERE request_id = $1", [
      request.binding.requestId,
    ]);
    await f.restart().settle(request.binding.requestId, request.binding.commandFingerprint, true);
    expect(await f.status()).toEqual(["PREPARED"]);
    expect(await f.charges()).toBe(1);
    const keys = (
      await pools.pricing.query<{ key: string }>("SELECT key FROM pricing_repricing_standing ORDER BY key")
    ).rows.map(({ key }) => key);
    expect(keys).toEqual([`repricing-account/${accountId}`, "repricing-platform-policy/pricing.repricing-engine"]);
    expect(original.reservations.some(({ resourceKey }) => resourceKey.includes("all-accounts"))).toBe(false);
  });

  it("checks the exclusive deadline after the global append lock, not before waiting", async () => {
    const f = await fixture();
    const request = await f.request("expired");
    const prepared = await f.authority.prepare(request.binding, request.listing, context);
    const lock = await pools.marketplace.connect();
    let append: Promise<unknown> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock($1::bigint)", [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY]);
      const end = (await lock.query<{ stamp: Date }>("SELECT clock_timestamp() + interval '1 second' AS stamp"))
        .rows[0]!.stamp;
      const expiresDuringWait: RequestTerminalBinding = {
        ...prepared.terminal,
        preparationDeadline: end.toISOString(),
      };
      await pools.marketplace.query("UPDATE event_request_terminals SET binding = $2 WHERE request_id = $1", [
        expiresDuringWait.requestId,
        expiresDuringWait,
      ]);
      append = f.market.appendToStreams!([
        {
          streamId: "synthetic.evaluation-did-not-commit",
          expectedVersion: "no_stream",
          context,
          requestTerminal: expiresDuringWait,
          configurationGrants: prepared.grants,
          events: [{ eventType: "synthetic.evaluation.accepted", payload: {} }],
        },
      ]).catch((error: unknown) => error);
      await lock.query("SELECT pg_sleep_until($1::timestamptz)", [end]);
      const waited = (
        await lock.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks AS locks
          WHERE NOT locks.granted AND locks.locktype = 'advisory'
          AND pg_backend_pid() = ANY(pg_blocking_pids(locks.pid))) AS waiting`,
        )
      ).rows[0]!.waiting;
      expect(waited).toBe(true);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      if (append) expect(await append).toMatchObject({ message: expect.stringContaining("DB-time window") });
    }
    expect(await f.market.readStream({ streamId: "synthetic.evaluation-did-not-commit" })).toEqual([]);
  });

  it("shortens the evaluation deadline to its captured Market Estimate expiry", async () => {
    const f = await fixture();
    const request = await f.request("earlier-expiry");
    const freshness = (
      await pools.pricing.query<{ fresh_until: Date }>(
        `INSERT INTO pricing_market_price_estimates (catalog_catalog_item_id, product_id, estimate_version,
         window_started_at, window_ended_at, amount, currency_code, confidence, estimated_at, fresh_until, disclosure, updated_at)
       VALUES ($1,$2,1,now()-interval '1 day',now(),15,'USD','high',now(),
         date_trunc('milliseconds', clock_timestamp()) + interval '20 seconds','internal',now())
       RETURNING fresh_until`,
        [catalogItemId, productId],
      )
    ).rows[0]!.fresh_until.toISOString();
    const { terminal } = await f.authority.prepare(request.binding, request.listing, context);
    const nextDay = new Date(
      Date.parse(`${terminal.preparationNotBefore!.slice(0, 10)}T00:00:00.000Z`) + 86_400_000,
    ).toISOString();
    expect(terminal.preparationDeadline).toBe(freshness < nextDay ? freshness : nextDay);
  });

  it("classifies competitors from the last committed category while the Catalog write is pending", async () => {
    const f = await fixture();
    const competitor = "acc_competitor_synthetic";
    await f.install(competitor, { kind: "catalog-filter", categoryIds: [categoryId] });
    await pools.pricing.query(
      `INSERT INTO pricing_market_listing_inputs (listing_id, seller_account_id, catalog_catalog_item_id,
         product_id, price_amount, price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       VALUES ('lst_competitor_synthetic',$1,$2,$3,9,'USD',1,'active',now(),1)`,
      [competitor, catalogItemId, productId],
    );
    const capture = async (suffix: string) => {
      const request = await f.request(suffix);
      await f.authority.prepare(request.binding, request.listing, context);
      const { evidence } = (
        await pools.pricing.query<{
          evidence: { competitors: { generation: string; parts: { asks: { pricingMode: string }[] }[] } };
        }>("SELECT evidence FROM pricing_evaluated_decisions WHERE request_id = $1", [request.binding.requestId])
      ).rows[0]!;
      await f.authority.settle(request.binding.requestId, request.binding.commandFingerprint, true);
      return { generation: evidence.competitors.generation, mode: evidence.competitors.parts[0]?.asks[0]?.pricingMode };
    };
    const before = await capture("before-category");
    expect(before.mode).toBe("hard");
    const writer = await pools.catalog.connect();
    try {
      await writer.query("BEGIN");
      await f.catalog.appendToStreamInTransaction(writer, {
        streamId: `catalog.item-${catalogItemId}`,
        expectedVersion: 1,
        context,
        events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId, categoryId } }],
      });
      expect(await capture("pending-category")).toEqual(before);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    const after = await capture("committed-category");
    expect(after.mode).toBe("derived");
    expect(after.generation).not.toBe(before.generation);
  });

  it("aborts the changed Catalog key and leaves another Item for the same seller free to commit", async () => {
    const f = await fixture({ kind: "catalog-filter", categoryIds: [categoryId] }, 2);
    const other = "cat_synthetic_unrelated";
    await f.createCatalogItem(other);
    for (const item of [catalogItemId, other]) {
      await f.catalog.appendToStream({
        streamId: `catalog.item-${item}`,
        expectedVersion: 1,
        context,
        events: [{ eventType: "catalog.catalog-item.category-assigned", payload: { catalogItemId: item, categoryId } }],
      });
    }
    const affected = await f.request("affected");
    const independent = await f.request("independent", f.identity, other);
    await f.authority.prepare(affected.binding, affected.listing, context);
    const { terminal, grants } = await f.authority.prepare(independent.binding, independent.listing, context);
    const catalogWriter = createPostgresEventStore({
      pool: pools.catalog,
      ownerPredicates: {
        consumerPool: pools.marketplace,
        keys: () => [ownerPredicateKey("repricing-catalog-category", catalogItemId, categoryId)],
      },
    });
    await catalogWriter.appendToStream({
      streamId: `catalog.item-${catalogItemId}`,
      expectedVersion: 2,
      context,
      events: [{ eventType: "catalog.catalog-item.category-removed", payload: { catalogItemId, categoryId } }],
    });
    await f.market.appendToStreams!([
      {
        streamId: "synthetic.independent-evaluation",
        expectedVersion: "no_stream",
        context,
        requestTerminal: terminal,
        configurationGrants: grants,
        events: [{ eventType: "synthetic.evaluation.accepted", payload: {} }],
      },
    ]);
    await f.authority.settle(affected.binding.requestId, affected.binding.commandFingerprint, false);
    await f.authority.settle(independent.binding.requestId, independent.binding.commandFingerprint, false);
    expect((await f.status()).sort()).toEqual(["ABORTED", "COMMITTED"]);
    expect(await f.charges()).toBe(1);
  });

  it("orders the worker's durable Product freeze against the original Pricing terminal", async () => {
    const f = await fixture();
    const product = { catalogItemId, productId };
    const now = (
      await pools.marketplace.query<{ stamp: Date }>("SELECT clock_timestamp() AS stamp")
    ).rows[0]!.stamp.toISOString();
    const policy = repricingEnginePolicy.defaultValue;
    for (let i = 1; i < policy.spiralBreakerRounds; i++)
      await recordProductRoundDirection(pools.pricing, product, "up", policy, now, pools.marketplace);
    const request = await f.request("freeze");
    await f.authority.prepare(request.binding, request.listing, context);
    expect(
      await recordProductRoundDirection(pools.pricing, product, "up", policy, now, pools.marketplace),
    ).not.toBeNull();
    await expect(f.restart().prepare(request.binding, request.listing, context)).rejects.toThrow();
    await f.restart().settle(request.binding.requestId, request.binding.commandFingerprint, false);
    expect(await f.status()).toEqual(["ABORTED"]);
    expect(await f.charges()).toBe(0);
    const fresh = await f.request("frozen");
    await expect(f.authority.prepare(fresh.binding, fresh.listing, context)).rejects.toThrow("Product is frozen");
  });

  it.each(["pricing-evaluated-decision", "pricing-daily-change-budget"] as const)(
    "restart refuses a partial preparation without its %s member",
    async (purpose) => {
      const f = await fixture();
      const request = await f.request(purpose);
      const prepared = await f.authority.prepare(request.binding, request.listing, context);
      const missing = prepared.terminal.reservations.find((member) => member.purpose === purpose)!;
      await pools.pricing.query("DELETE FROM event_owner_stream_reservations WHERE reservation_id = $1", [
        missing.reservationId,
      ]);
      await expect(f.restart().prepare(request.binding, request.listing, context)).rejects.toThrow("incomplete");
      expect(await f.status()).toEqual(["PREPARED"]);
      expect(await f.charges()).toBe(1);
    },
  );
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildOrderingOrderProjectionHandlers } from "../read-model/projection";
import { module as orderingModule } from "../../../index";
import { claimPlanPurchaseLimitUsage, releasePurchaseLimitClaimsForOrder } from "./purchase-limits";
import { claimOrderSource, compensatePendingOrderSourceClaim, getOrderSourceClaim } from "./order-source-claims";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  productMeasureForCandidate,
  shipFromAddress,
  shippingAddress,
  type SupplyCandidate,
} from "./runtime-test-harness";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

describeDb("ordering purchase limits db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_purchase_limits");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
    await pools.ordering.query(eventCorePostgresSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function supply(listingId: string, limit = 1) {
    const candidate: SupplyCandidate = {
      listingId,
      sellerAccountId: `acc_${listingId}`,
      inventoryItemId: `inv_${listingId}`,
      catalogItemId: `cat_${listingId}`,
      productId: `cat_${listingId}::`,
      itemTitle: "Card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      storageLocationName: null,
      shipFromCode: "CHI",
      priceAmount: "150.00",
      availableQuantity: 10,
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    await pools.ordering.query(
      `INSERT INTO ordering_inventory_item_inputs
       (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, updated_at, last_stream_version)
       VALUES ($1, $2, $3, $4, 10, now(), 1)`,
      [candidate.inventoryItemId, candidate.sellerAccountId, candidate.catalogItemId, candidate.productId],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_market_listing_inputs
       (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, item_title,
        ship_from_code, ship_from_address, product_measure_snapshot, price_amount, price_currency_code,
        listing_stream_version, marketplace_sales_fee_unit_amount, seller_net_unit_amount, terms_resolved_at,
        quantity_cap, max_units_per_day, max_units_per_customer_account, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Card', 'CHI', $6::jsonb, $7::jsonb, 150, 'USD', 1, 1, 149, now(), 10, $8, $8, 'active', now())`,
      [
        listingId,
        candidate.sellerAccountId,
        candidate.inventoryItemId,
        candidate.catalogItemId,
        candidate.productId,
        JSON.stringify(shipFromAddress),
        JSON.stringify(productMeasureForCandidate(candidate)),
        limit,
      ],
    );
  }

  function checkout(listingIds = ["lst_a"], checkoutSessionId = "chk_limit") {
    return {
      buyerAccountId: context.audit.forAccountId,
      checkoutSessionId,
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: listingIds.map((listingId) => ({
        listingId,
        cartLineId: `cli_${listingId}`,
        catalogItemId: `cat_${listingId}`,
        productId: `cat_${listingId}::`,
        itemTitle: "Card",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      })),
    };
  }

  function runtime(eventStore: EventStore = createPostgresEventStore({ pool: pools.ordering }), db = pools.ordering) {
    return createOrderingOrderRuntimeForTest({
      db,
      eventStore,
      checkpointStore: createCheckpointStore(),
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
    });
  }

  async function snapshot() {
    const [claims, usage, sources, streams] = await Promise.all([
      pools.ordering.query(
        "SELECT source_reference_id, buyer_account_id, listing_id, quantity, status, claimed_at::date::text AS claimed_day FROM ordering_listing_purchase_limit_claims ORDER BY source_reference_id, listing_id",
      ),
      pools.ordering.query(
        "SELECT buyer_account_id, listing_id, marketplace_day::text, day_quantity, customer_account_quantity FROM ordering_listing_purchase_limit_usage ORDER BY buyer_account_id, listing_id",
      ),
      pools.ordering.query(
        "SELECT source_reference_id, buyer_account_id, order_ids, status FROM ordering_order_source_claims ORDER BY source_reference_id",
      ),
      pools.ordering.query(
        "SELECT stream_id FROM event_store_streams WHERE stream_id LIKE 'ordering.order-%' ORDER BY stream_id",
      ),
    ]);
    return { claims: claims.rows, usage: usage.rows, sources: sources.rows, streams: streams.rows };
  }

  function failQuery(match: string): PgTransactionalPool {
    const wrap =
      (db: PgQueryable): PgQueryable["query"] =>
      async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes(match)) throw new Error("injected database failure");
        return db.query<Row>(sql, params);
      };
    return {
      query: wrap(pools.ordering),
      connect: async () => {
        const client = await pools.ordering.connect();
        return { query: wrap(client), release: client.release.bind(client) };
      },
    };
  }

  it.each([false, true])("purchase-limit-plan-claim-is-atomic: reversed=%s", async (reversed) => {
    await supply("lst_a");
    await supply("lst_b");
    const plan = (sourceReferenceId: string, listingIds: string[]) => ({
      orderDrafts: [
        {
          sourceType: "cart-checkout" as const,
          sourceReferenceId,
          lines: listingIds.map((listingId) => ({ listingId, quantity: 1 })),
        },
      ],
    });
    await claimPlanPurchaseLimitUsage(pools.ordering, context.audit.forAccountId, plan("chk_prior", ["lst_b"]));
    const before = await snapshot();
    await expect(
      claimPlanPurchaseLimitUsage(
        pools.ordering,
        context.audit.forAccountId,
        plan("chk_atomic", reversed ? ["lst_b", "lst_a"] : ["lst_a", "lst_b"]),
      ),
    ).rejects.toThrow("purchase limit reached");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["source", "admission", "first append"])("checkout-no-order-failure-releases-limit: %s", async (failure) => {
    await supply("lst_a");
    const store = createPostgresEventStore({ pool: pools.ordering });
    const failingStore: EventStore = {
      ...store,
      appendToStream: async () => {
        throw new Error("first append failed");
      },
    };
    const db =
      failure === "source"
        ? failQuery("INSERT INTO ordering_order_source_claims")
        : failure === "admission"
          ? failQuery("SET day_quantity = day_quantity +")
          : pools.ordering;
    await expect(
      runtime(failure === "first append" ? failingStore : store, db).createOrdersFromCheckout(checkout(), context),
    ).rejects.toThrow(failure === "first append" ? "first append failed" : "injected database failure");
    const after = await snapshot();
    expect(after.claims).toEqual([]);
    expect(after.sources).toEqual([]);
    expect(after.streams).toEqual([]);
    expect(after.usage.every((row) => row.day_quantity === 0 && row.customer_account_quantity === 0)).toBe(true);
    const result = await runtime().createOrdersFromCheckout(checkout(["lst_a"], "chk_another"), context);
    expect(result.orderIds).toHaveLength(1);
    expect((await snapshot()).usage).toEqual([
      expect.objectContaining({ day_quantity: 1, customer_account_quantity: 1 }),
    ]);
  });

  it("checkout-partial-order-failure-preserves-source-limit", async () => {
    await supply("lst_a");
    await supply("lst_b");
    const store = createPostgresEventStore({ pool: pools.ordering });
    let appends = 0;
    const failingStore: EventStore = {
      ...store,
      appendToStream: async (input) => {
        if (++appends === 2) throw new Error("later append failed");
        return store.appendToStream(input);
      },
    };
    const params = checkout(["lst_a", "lst_b"]);
    await expect(runtime(failingStore).createOrdersFromCheckout(params, context)).rejects.toThrow(
      "later append failed",
    );
    const beforeRetry = await snapshot();
    expect(beforeRetry.sources).toEqual([expect.objectContaining({ status: "pending", order_ids: expect.any(Array) })]);
    const claim = await getOrderSourceClaim(pools.ordering, params.sourceType, params.checkoutSessionId);
    expect(claim?.orderIds).toHaveLength(2);
    expect(beforeRetry.streams).toEqual([{ stream_id: `ordering.order-${claim!.orderIds[0]}` }]);
    expect(beforeRetry.claims).toHaveLength(2);
    expect(beforeRetry.claims.every((row) => row.status === "claimed")).toBe(true);
    expect(beforeRetry.usage.every((row) => row.day_quantity === 1 && row.customer_account_quantity === 1)).toBe(true);
    await expect(runtime().createOrdersFromCheckout(params, context)).rejects.toThrow("already in progress");
    expect(await snapshot()).toEqual(beforeRetry);
  });

  it("preserves limits when source completion fails after durable append", async () => {
    await supply("lst_a");
    await expect(
      runtime(undefined, failQuery("UPDATE ordering_order_source_claims")).createOrdersFromCheckout(
        checkout(),
        context,
      ),
    ).rejects.toThrow("injected database failure");
    const before = await snapshot();
    expect(before.streams).toHaveLength(1);
    expect(before.claims).toEqual([expect.objectContaining({ status: "claimed" })]);
    const result = await runtime().createOrdersFromCheckout(checkout(), context);
    const after = await snapshot();
    expect(after.streams).toEqual(before.streams);
    expect(after.claims).toEqual(before.claims);
    expect(after.usage).toEqual(before.usage);
    expect(after.sources).toEqual([expect.objectContaining({ status: "created", order_ids: result.orderIds })]);
  });

  it.each([0, 1])("purchase-limit-source-retry-concurrency: day +%i", async (daysUntilRetry) => {
    const clock = await pools.ordering.query<{ now: Date }>("SELECT now() AS now");
    const retryAt = clock.rows[0]!.now;
    const claimedAt = new Date(retryAt.getTime() - daysUntilRetry * 24 * 60 * 60 * 1_000);
    const claimedDay = claimedAt.toISOString().slice(0, 10);
    const retryDay = retryAt.toISOString().slice(0, 10);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(claimedAt);
    await supply("lst_a");
    const store = createPostgresEventStore({ pool: pools.ordering });
    let signalEntered!: () => void;
    let signalResume!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      signalResume = resolve;
    });
    const failingStore: EventStore = {
      ...store,
      appendToStream: async () => {
        if (daysUntilRetry > 0) {
          // Model the historical attempt in PostgreSQL too: its now() does not follow Vitest's clock.
          await pools.ordering.query(
            `UPDATE ordering_listing_purchase_limit_claims SET claimed_at = $1::timestamptz
             WHERE source_type = 'cart-checkout' AND source_reference_id = 'chk_limit'
               AND buyer_account_id = $2`,
            [claimedAt.toISOString(), context.audit.forAccountId],
          );
        }
        signalEntered();
        await resume;
        throw new Error("owned attempt failed");
      },
    };
    const pending = runtime(failingStore).createOrdersFromCheckout(checkout(), context);
    const failed = expect(pending).rejects.toThrow("owned attempt failed");
    await entered;
    const owned = (await getOrderSourceClaim(pools.ordering, "cart-checkout", "chk_limit"))!;
    const before = await snapshot();
    expect(before.claims).toEqual([expect.objectContaining({ claimed_day: claimedDay, status: "claimed" })]);
    expect(before.usage).toEqual([
      expect.objectContaining({ marketplace_day: claimedDay, day_quantity: 1, customer_account_quantity: 1 }),
    ]);
    await expect(runtime().createOrdersFromCheckout(checkout(), context)).rejects.toThrow("already in progress");
    expect(await snapshot()).toEqual(before);
    signalResume();
    await failed;
    const compensated = await snapshot();
    expect(compensated.claims).toEqual([]);
    expect(compensated.sources).toEqual([]);
    expect(compensated.streams).toEqual([]);
    expect(compensated.usage).toEqual([
      expect.objectContaining({ marketplace_day: claimedDay, day_quantity: 0, customer_account_quantity: 0 }),
    ]);
    vi.setSystemTime(retryAt);
    const result = await runtime().createOrdersFromCheckout(checkout(), context);
    expect((await runtime().createOrdersFromCheckout(checkout(), context)).orderIds).toEqual(result.orderIds);
    const succeeded = await snapshot();
    const authorityProbe = vi.fn(async () => false);
    await compensatePendingOrderSourceClaim(pools.ordering, owned, authorityProbe);
    expect(authorityProbe).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(succeeded);
    expect(succeeded.claims).toEqual([expect.objectContaining({ claimed_day: retryDay, status: "claimed" })]);
    expect(succeeded.usage).toEqual([
      expect.objectContaining({ marketplace_day: retryDay, day_quantity: 1, customer_account_quantity: 1 }),
    ]);
    const projection = buildOrderingOrderProjectionHandlers(pools.ordering);
    const orderEvents = await store.readStream({ streamId: `ordering.order-${result.orderIds[0]}` });
    for (const stored of orderEvents) {
      const event = toTransportEvent(stored);
      await projection[event.type]?.(event);
    }
    await runtime().cancelPurchase(
      { orderId: result.orderIds[0]!, buyerAccountId: context.audit.forAccountId },
      context,
    );
    const order = {
      source_type: "cart-checkout",
      source_reference_id: "chk_limit",
      buyer_account_id: context.audit.forAccountId,
      lines: [{ listing_id: "lst_a" }],
    };
    await Promise.all([
      releasePurchaseLimitClaimsForOrder(pools.ordering, order),
      releasePurchaseLimitClaimsForOrder(pools.ordering, order),
    ]);
    expect((await snapshot()).usage).toEqual([
      expect.objectContaining({ marketplace_day: retryDay, day_quantity: 0, customer_account_quantity: 0 }),
    ]);
  });

  it("stale compensation cannot release a replacement pending source", async () => {
    const source = {
      sourceType: "cart-checkout" as const,
      sourceReferenceId: "chk_limit",
      buyerAccountId: context.audit.forAccountId,
    };
    const old = { ...source, orderIds: ["ord_old" as OrderId] };
    await claimOrderSource(pools.ordering, { ...source, orderIds: ["ord_replacement" as OrderId] });
    const before = await snapshot();
    const authorityProbe = vi.fn(async () => false);
    await compensatePendingOrderSourceClaim(pools.ordering, old, authorityProbe);
    expect(authorityProbe).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("compensates only the owned source once while another source uses the same listing", async () => {
    await supply("lst_a", 2);
    const claim = async (sourceReferenceId: string) => {
      const source = {
        sourceType: "cart-checkout" as const,
        sourceReferenceId,
        buyerAccountId: context.audit.forAccountId,
        orderIds: [`ord_${sourceReferenceId}` as OrderId],
      };
      await claimOrderSource(pools.ordering, source);
      await claimPlanPurchaseLimitUsage(pools.ordering, source.buyerAccountId, {
        orderDrafts: [{ ...source, lines: [{ listingId: "lst_a", quantity: 1 }] }],
      });
      return source;
    };
    const failed = await claim("chk_failed");
    await claim("chk_other");
    expect((await snapshot()).usage).toEqual([
      expect.objectContaining({ day_quantity: 2, customer_account_quantity: 2 }),
    ]);
    await Promise.all([
      compensatePendingOrderSourceClaim(pools.ordering, failed, async () => false),
      compensatePendingOrderSourceClaim(pools.ordering, failed, async () => false),
    ]);
    const after = await snapshot();
    expect(after.claims).toEqual([expect.objectContaining({ source_reference_id: "chk_other", status: "claimed" })]);
    expect(after.sources).toEqual([expect.objectContaining({ source_reference_id: "chk_other", status: "pending" })]);
    expect(after.usage).toEqual([expect.objectContaining({ day_quantity: 1, customer_account_quantity: 1 })]);
    await claim("chk_failed");
    expect((await snapshot()).usage).toEqual([
      expect.objectContaining({ day_quantity: 2, customer_account_quantity: 2 }),
    ]);
  });

  it("restores day and customer account quantities when released claim timestamps are parsed as Date", async () => {
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_claims (
         claim_id,
         source_type,
         source_reference_id,
         buyer_account_id,
         listing_id,
         quantity,
         status,
         claimed_at,
         released_at
       )
       VALUES ('opl_claim_1', 'cart-checkout', 'chk_1', 'acct_buyer', 'lst_1', 2, 'claimed', $1::timestamptz, NULL)`,
      ["2026-07-02T15:30:00.000Z"],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_usage (
         buyer_account_id,
         listing_id,
         marketplace_day,
         day_quantity,
         customer_account_quantity,
         updated_at
       )
       VALUES ('acct_buyer', 'lst_1', '2026-07-02'::date, 2, 2, now())`,
    );

    await releasePurchaseLimitClaimsForOrder(pools.ordering, {
      source_type: "cart-checkout",
      source_reference_id: "chk_1",
      buyer_account_id: "acct_buyer",
      lines: [{ listing_id: "lst_1" }],
    });

    const claim = await pools.ordering.query<{ status: string; released_at: Date | null }>(
      `SELECT status, released_at
       FROM ordering_listing_purchase_limit_claims
       WHERE claim_id = 'opl_claim_1'`,
    );
    const usage = await pools.ordering.query<{
      day_quantity: number | string;
      customer_account_quantity: number | string;
    }>(
      `SELECT day_quantity, customer_account_quantity
       FROM ordering_listing_purchase_limit_usage
       WHERE buyer_account_id = 'acct_buyer'
         AND listing_id = 'lst_1'`,
    );

    expect(claim.rows[0]).toMatchObject({ status: "released" });
    expect(claim.rows[0]?.released_at).toBeInstanceOf(Date);
    expect(Number(usage.rows[0]?.day_quantity)).toBe(0);
    expect(Number(usage.rows[0]?.customer_account_quantity)).toBe(0);
  });
});

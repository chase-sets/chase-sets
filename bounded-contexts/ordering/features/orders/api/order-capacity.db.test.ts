import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPgPool,
  eventCorePostgresSchemaSql,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { OrderId, AccountId } from "@chase-sets/primitives/typed-ids";
import { module as orderingModule } from "../../../index";
import { orderingOrderSchemaMigrations } from "../read-model/schema";
import { claimOrderSource, compensatePendingOrderSourceClaim, getOrderSourceClaim } from "./order-source-claims";
import { bindEvidenceWindowSource } from "./evidence-window-source-release";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  productMeasureForCandidate,
  shipFromAddress,
  shippingAddress,
  type SupplyCandidate,
} from "./runtime-test-harness";
import {
  backfillSellerOpenOrderClaims,
  claimSellerOrderCapacity,
  loadSellerOrderCapacityCap,
  reconcileSellerOrderCapacity,
  releaseSellerOrderCapacityClaim,
} from "./order-capacity";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

async function setSellerCap(pool: PgTransactionalPool, sellerAccountId: string, maxOpenOrders: number | null) {
  await pool.query(
    `INSERT INTO ordering_seller_order_capacity_inputs (seller_account_id, max_open_orders, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (seller_account_id) DO UPDATE
     SET max_open_orders = EXCLUDED.max_open_orders, updated_at = EXCLUDED.updated_at`,
    [sellerAccountId, maxOpenOrders],
  );
}

async function openClaimCount(pool: PgTransactionalPool, sellerAccountId: string) {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ordering_seller_open_order_claims WHERE seller_account_id = $1 AND status = 'claimed'`,
    [sellerAccountId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describeDb("ordering seller order capacity db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let databaseUrls: Readonly<Record<(typeof contextNames)[number], string>>;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_order_capacity");
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

  async function supply(listingId = "lst_a") {
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
       VALUES ($1, $2, $3, $4, $5, 'Card', 'CHI', $6::jsonb, $7::jsonb, 150, 'USD', 1, 1, 149, now(), 10, 2, 2, 'active', now())`,
      [
        listingId,
        candidate.sellerAccountId,
        candidate.inventoryItemId,
        candidate.catalogItemId,
        candidate.productId,
        JSON.stringify(shipFromAddress),
        JSON.stringify(productMeasureForCandidate(candidate)),
      ],
    );
    await setSellerCap(pools.ordering, candidate.sellerAccountId, 1);
  }

  function checkout(checkoutSessionId = "chk_failed", listingIds = ["lst_a"]) {
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
    const [capacity, purchase, usage, sources, orders] = await Promise.all([
      pools.ordering.query(
        "SELECT order_id, seller_account_id, status FROM ordering_seller_open_order_claims ORDER BY order_id",
      ),
      pools.ordering.query(
        "SELECT source_reference_id, buyer_account_id, status FROM ordering_listing_purchase_limit_claims ORDER BY source_reference_id, listing_id",
      ),
      pools.ordering.query(
        "SELECT buyer_account_id, day_quantity, customer_account_quantity FROM ordering_listing_purchase_limit_usage ORDER BY buyer_account_id, listing_id",
      ),
      pools.ordering.query(
        "SELECT source_reference_id, order_ids, status FROM ordering_order_source_claims ORDER BY source_reference_id",
      ),
      pools.ordering.query(
        "SELECT stream_id FROM event_store_streams WHERE stream_id LIKE 'ordering.order-%' ORDER BY stream_id",
      ),
    ]);
    return {
      capacity: capacity.rows,
      purchase: purchase.rows,
      usage: usage.rows,
      sources: sources.rows,
      orders: orders.rows,
    };
  }

  async function signalTypes(store: EventStore, seller = "acc_lst_a") {
    return (await store.readStream({ streamId: `ordering.seller-capacity-${seller}` })).map((event) => event.eventType);
  }

  it("F1 reconciles and completes zero-Order compensation with a one-connection Postgres pool", async () => {
    const pool = createPgPool(databaseUrls.ordering, { max: 1, connectionTimeoutMillis: 1000 });
    try {
      await supply();
      const store = createPostgresEventStore({ pool });
      await claimSellerOrderCapacity(pool, [{ sellerAccountId: "acc_lst_a", orderIds: ["ord_pool_control"] }]);
      await runtime(store, pool).reconcileSellerOrderCapacitySignal("acc_lst_a", context);
      expect(await signalTypes(store)).toEqual(["ordering.seller-capacity.reached"]);
      await releaseSellerOrderCapacityClaim(pool, "ord_pool_control", new Date().toISOString());
      await runtime(store, pool).reconcileSellerOrderCapacitySignal("acc_lst_a", context);

      const appendFailure = new Error("first append failed");
      const failing = {
        ...store,
        appendToStream: async (input: Parameters<EventStore["appendToStream"]>[0]) => {
          if (input.streamId.startsWith("ordering.order-")) throw appendFailure;
          return store.appendToStream(input);
        },
      };
      await expect(runtime(failing, pool).createOrdersFromCheckout(checkout(), context)).rejects.toBe(appendFailure);
      expect(await getOrderSourceClaim(pool, "cart-checkout", "chk_failed")).toBeNull();
      expect(await openClaimCount(pool, "acc_lst_a")).toBe(0);
      expect((await snapshot()).orders).toEqual([]);
      expect((await snapshot()).purchase).toEqual([]);
      expect(await signalTypes(store)).toEqual([
        "ordering.seller-capacity.reached",
        "ordering.seller-capacity.cleared",
        "ordering.seller-capacity.reached",
        "ordering.seller-capacity.cleared",
      ]);
    } finally {
      await closeMultiContextTestPools({ ordering: pool });
    }
  });

  it.each([false, true])(
    "AC1 releases zero-Order claims and admits the source the next day; explicit IDs=%s",
    async (explicitIds) => {
      await supply();
      const params = { ...checkout(), ...(explicitIds ? { orderIdsOverride: ["ord_seed" as OrderId] } : {}) };
      const store = createPostgresEventStore({ pool: pools.ordering });
      const failing: EventStore = {
        ...store,
        appendToStream: async (input) => {
          if (input.streamId.startsWith("ordering.order-")) throw new Error("first append failed");
          return store.appendToStream(input);
        },
      };
      await expect(runtime(failing).createOrdersFromCheckout(params, context)).rejects.toThrow("first append failed");
      const after = await snapshot();
      expect(after.orders).toEqual([]);
      expect(after.sources).toEqual([]);
      expect(after.purchase).toEqual([]);
      expect(after.capacity).toEqual([]);
      expect(after.usage).toEqual([expect.objectContaining({ day_quantity: 0, customer_account_quantity: 0 })]);
      expect(await signalTypes(store)).toEqual([
        "ordering.seller-capacity.reached",
        "ordering.seller-capacity.cleared",
      ]);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.now() + 86_400_000));
        const created = await runtime().createOrdersFromCheckout(params, context);
        expect(created.orderIds).toHaveLength(1);
        if (explicitIds) expect(created.orderIds).toEqual(["ord_seed"]);
        expect(
          (await store.readStream({ streamId: `ordering.order-${created.orderIds[0]}` })).map(
            (event) => event.eventType,
          ),
        ).toEqual(["ordering.order.created", "ordering.order.line-item-amounts-published"]);
        expect(await openClaimCount(pools.ordering, "acc_lst_a")).toBe(1);
        expect((await getOrderSourceClaim(pools.ordering, "cart-checkout", "chk_failed"))?.status).toBe("created");
        expect((await runtime().createOrdersFromCheckout(params, context)).orderIds).toEqual(created.orderIds);
        expect(await signalTypes(store)).toEqual([
          "ordering.seller-capacity.reached",
          "ordering.seller-capacity.cleared",
          "ordering.seller-capacity.reached",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("AC3 retains compensating identity across signal failures and serializes retries with an unrelated buyer", async () => {
    await supply();
    const store = createPostgresEventStore({ pool: pools.ordering });
    const originalError = new Error("first append failed", { cause: new Error("append cause") });
    const signalError = new Error("signal failed");
    const failing = {
      ...store,
      appendToStream: async (input: Parameters<EventStore["appendToStream"]>[0]) => {
        if (input.streamId.startsWith("ordering.order-")) throw originalError;
        return store.appendToStream(input);
      },
      appendToStreamInTransaction: async (client: PgQueryable, input: Parameters<EventStore["appendToStream"]>[0]) => {
        if (input.events.some((event) => event.eventType === "ordering.seller-capacity.cleared")) throw signalError;
        return store.appendToStreamInTransaction(client, input);
      },
    };
    await expect(runtime(failing).createOrdersFromCheckout(checkout(), context)).rejects.toBe(originalError);
    expect(originalError.cause).toBeInstanceOf(AggregateError);
    expect(originalError.cause).toMatchObject({
      errors: [expect.objectContaining({ message: "append cause" }), signalError],
    });
    const claim = (await getOrderSourceClaim(pools.ordering, "cart-checkout", "chk_failed"))!;
    expect(claim.status).toBe("compensating");
    const beforeRetry = await snapshot();
    expect(beforeRetry.orders).toEqual([]);
    expect(beforeRetry.purchase).toEqual([]);
    expect(beforeRetry.capacity).toEqual([
      expect.objectContaining({ order_id: claim.orderIds[0], status: "released" }),
    ]);
    await expect(runtime(failing).createOrdersFromCheckout(checkout(), context)).rejects.toThrow("signal failed");
    expect(await snapshot()).toEqual(beforeRetry);
    const reconcile = (seller: string) => runtime().reconcileSellerOrderCapacitySignal(seller, context);
    await Promise.all([
      compensatePendingOrderSourceClaim(pools.ordering, claim, async () => false, false, reconcile),
      compensatePendingOrderSourceClaim(pools.ordering, claim, async () => false, false, reconcile),
      runtime().createOrdersFromCheckout(
        { ...checkout("chk_other"), buyerAccountId: "acc_other" as AccountId },
        context,
      ),
    ]);
    const after = await snapshot();
    expect(after.capacity).toHaveLength(1);
    expect(after.capacity.some((row) => row.order_id === claim.orderIds[0])).toBe(false);
    expect(await openClaimCount(pools.ordering, "acc_lst_a")).toBe(1);
    expect(after.orders).toHaveLength(1);
    expect(after.sources).toEqual([expect.objectContaining({ source_reference_id: "chk_other", status: "created" })]);
    expect(after.purchase).toEqual([
      { source_reference_id: "chk_other", buyer_account_id: "acc_other", status: "claimed" },
    ]);
    expect((await signalTypes(store)).at(-1)).toBe("ordering.seller-capacity.reached");
    await compensatePendingOrderSourceClaim(pools.ordering, claim, async () => false, false, reconcile);
    expect(await snapshot()).toEqual(after);
  });

  it.each(["reached", "cleared"])(
    "AC3 checkout retries reconcile a failed %s signal before readmission",
    async (failedSignal) => {
      await supply();
      const store = createPostgresEventStore({ pool: pools.ordering });
      const failing = {
        ...store,
        appendToStream: async (input: Parameters<EventStore["appendToStream"]>[0]) => {
          if (input.streamId.startsWith("ordering.order-")) throw new Error("first append failed");
          return store.appendToStream(input);
        },
        appendToStreamInTransaction: async (
          client: PgQueryable,
          input: Parameters<EventStore["appendToStream"]>[0],
        ) => {
          if (input.events.some((event) => event.eventType === `ordering.seller-capacity.${failedSignal}`)) {
            throw new Error("signal failed");
          }
          return store.appendToStreamInTransaction(client, input);
        },
      };
      await expect(runtime(failing).createOrdersFromCheckout(checkout(), context)).rejects.toThrow(
        failedSignal === "cleared" ? "first append failed" : "signal failed",
      );
      const afterFailure = await snapshot();
      expect(afterFailure.orders).toEqual([]);
      expect(afterFailure.capacity).toEqual(
        failedSignal === "cleared" ? [expect.objectContaining({ status: "released" })] : [],
      );
      expect(afterFailure.purchase).toEqual([]);
      expect(afterFailure.sources).toEqual(
        failedSignal === "cleared" ? [expect.objectContaining({ status: "compensating" })] : [],
      );
      const result = await runtime().createOrdersFromCheckout(checkout(), context);
      expect(result.orderIds).toHaveLength(1);
      expect(
        (await store.readStream({ streamId: `ordering.order-${result.orderIds[0]}` })).map((event) => event.eventType),
      ).toEqual(["ordering.order.created", "ordering.order.line-item-amounts-published"]);
      expect(await signalTypes(store)).toEqual(
        failedSignal === "cleared"
          ? ["ordering.seller-capacity.reached", "ordering.seller-capacity.cleared", "ordering.seller-capacity.reached"]
          : ["ordering.seller-capacity.reached"],
      );
      expect(await openClaimCount(pools.ordering, "acc_lst_a")).toBe(1);
      expect((await getOrderSourceClaim(pools.ordering, "cart-checkout", "chk_failed"))?.status).toBe("created");
    },
  );

  it("AC2 preserves an active pending owner and every claim after a partial append", async () => {
    await supply();
    await supply("lst_b");
    const store = createPostgresEventStore({ pool: pools.ordering });
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let orderAppends = 0;
    const failing: EventStore = {
      ...store,
      appendToStream: async (input) => {
        if (input.streamId.startsWith("ordering.order-")) {
          if (++orderAppends === 1) {
            entered();
            await resumed;
          } else throw new Error("second append failed");
        }
        return store.appendToStream(input);
      },
    };
    const params = checkout("chk_partial", ["lst_a", "lst_b"]);
    const pending = expect(runtime(failing).createOrdersFromCheckout(params, context)).rejects.toThrow(
      "second append failed",
    );
    await waiting;
    try {
      const before = await snapshot();
      expect(before.orders).toEqual([]);
      expect(before.capacity.filter((row) => row.status === "claimed")).toHaveLength(2);
      await expect(runtime().createOrdersFromCheckout(params, context)).rejects.toThrow("already in progress");
      expect(await snapshot()).toEqual(before);
    } finally {
      resume();
    }
    await pending;
    const after = await snapshot();
    expect(after.orders).toHaveLength(1);
    expect(after.capacity.every((row) => row.status === "claimed")).toBe(true);
    expect(after.purchase).toHaveLength(2);
    expect(after.purchase.every((row) => row.status === "claimed")).toBe(true);
    const claim = (await getOrderSourceClaim(pools.ordering, params.sourceType, params.checkoutSessionId))!;
    expect(claim.status).toBe("pending");
    const streams = await Promise.all(
      claim.orderIds.map((id) => store.readStream({ streamId: `ordering.order-${id}` })),
    );
    expect(streams.map((events) => events.map((event) => event.eventType))).toEqual([
      ["ordering.order.created", "ordering.order.line-item-amounts-published"],
      [],
    ]);
    await expect(runtime().createOrdersFromCheckout(params, context)).rejects.toThrow("already in progress");
    expect(await snapshot()).toEqual(after);
  });

  it("AC1 rolls back capacity, purchase usage and source transition together if compensation fails", async () => {
    await supply();
    const store = createPostgresEventStore({ pool: pools.ordering });
    const failing: EventStore = {
      ...store,
      appendToStream: async (input) => {
        if (input.streamId.startsWith("ordering.order-")) throw new Error("first append failed");
        return store.appendToStream(input);
      },
    };
    const wrap =
      (db: PgQueryable): PgQueryable["query"] =>
      async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("SET status = 'compensating'")) throw new Error("compensation failed");
        return db.query<Row>(sql, values);
      };
    const db: PgTransactionalPool = {
      query: wrap(pools.ordering),
      connect: async () => {
        const client = await pools.ordering.connect();
        return { query: wrap(client), release: client.release.bind(client) };
      },
    };
    await expect(runtime(failing, db).createOrdersFromCheckout(checkout(), context)).rejects.toMatchObject({
      message: "first append failed",
      cause: { errors: [expect.objectContaining({ message: "compensation failed" })] },
    });
    const after = await snapshot();
    expect(after.orders).toEqual([]);
    expect(after.capacity).toEqual([expect.objectContaining({ status: "claimed" })]);
    expect(after.purchase).toEqual([expect.objectContaining({ status: "claimed" })]);
    expect(after.sources).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(after.usage).toEqual([expect.objectContaining({ day_quantity: 1, customer_account_quantity: 1 })]);
    const claim = (await getOrderSourceClaim(pools.ordering, "cart-checkout", "chk_failed"))!;
    await compensatePendingOrderSourceClaim(
      pools.ordering,
      claim,
      async () => false,
      false,
      (seller) => runtime().reconcileSellerOrderCapacitySignal(seller, context),
    );
    expect(await openClaimCount(pools.ordering, "acc_lst_a")).toBe(0);
    expect((await snapshot()).sources).toEqual([]);
  });

  it("AC2 refuses ordinary compensation for governed sources without changing their observed facts", async () => {
    const source = {
      sourceType: "cart-checkout" as const,
      sourceReferenceId: "chk_governed",
      buyerAccountId: context.audit.forAccountId,
      orderIds: ["ord_governed" as OrderId],
    };
    await bindEvidenceWindowSource(pools.ordering, {
      sourceIdentity: source,
      windowId: "abcdef0123456789abcdef0123456789",
      subInvocation: "2a",
      windowOpenedAt: new Date().toISOString(),
    });
    await claimOrderSource(pools.ordering, source, true, true);
    await claimSellerOrderCapacity(
      pools.ordering,
      [{ sellerAccountId: "acc_seller", orderIds: source.orderIds }],
      undefined,
      source,
    );
    const before = await snapshot();
    const observedBefore = await runtime().evidenceWindowSources.observe(source);
    expect(observedBefore).toMatchObject({
      outcome: "owed",
      surfaces: { sourceClaim: "owed", capacityAndSellerSignals: "owed" },
    });
    await compensatePendingOrderSourceClaim(
      pools.ordering,
      source,
      async () => false,
      true,
      async () => {
        throw new Error("must not signal");
      },
    );
    expect(await snapshot()).toEqual(before);
    expect(await runtime().evidenceWindowSources.observe(source)).toEqual(observedBefore);
    expect(await openClaimCount(pools.ordering, "acc_seller")).toBe(1);
  });

  it("migrates pending and created sources and reapplies the compensating status constraint", async () => {
    const db = pools.ordering;
    await db.query(`ALTER TABLE ordering_order_source_claims DROP CONSTRAINT ordering_order_source_claims_status_check;
      ALTER TABLE ordering_order_source_claims ADD CONSTRAINT ordering_order_source_claims_status_check CHECK (status IN ('pending', 'created'))`);
    await db.query(`INSERT INTO ordering_order_source_claims (source_type, source_reference_id, buyer_account_id, order_ids, status)
      VALUES ('cart-checkout', 'chk_pending', 'acc_buyer', '["ord_pending"]', 'pending'),
             ('cart-checkout', 'chk_created', 'acc_buyer', '["ord_created"]', 'created')`);
    const migration = orderingOrderSchemaMigrations.find(
      (item) => item.migrationId === "20260927_ordering_order_source_compensation",
    )!;
    for (const sql of migration.statements) await db.query(sql);
    await db.query(`INSERT INTO ordering_order_source_claims (source_type, source_reference_id, buyer_account_id, order_ids, status)
      VALUES ('cart-checkout', 'chk_compensating', 'acc_buyer', '["ord_compensating"]', 'compensating')`);
    for (const sql of migration.statements) await db.query(sql);
    expect((await snapshot()).sources.map((row) => row.status)).toEqual(["compensating", "created", "pending"]);
    await expect(db.query("UPDATE ordering_order_source_claims SET status = 'invalid'")).rejects.toThrow(
      "ordering_order_source_claims_status_check",
    );
  });

  it("takes no lock and claims freely when no cap is set (unlimited)", async () => {
    const db = pools.ordering;

    expect(await loadSellerOrderCapacityCap(db, "acc_seller")).toBeNull();

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);
    // No capacity row is created just from an unlimited claim -- the fast
    // pre-check short-circuits before the seed-and-lock step.
    const capacityRow = await db.query(
      `SELECT 1 FROM ordering_seller_order_capacity_inputs WHERE seller_account_id = $1`,
      ["acc_seller"],
    );
    expect(capacityRow.rowCount).toBe(0);
  });

  it("claims up to the cap and rejects the group once it would be exceeded", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 2);

    const first = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2"] }]);
    expect(first.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);

    const second = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_3"] }]);
    expect(second.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);
  });

  it("claims a multi-order seller group atomically -- all or nothing", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 2);

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2", "ord_3"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(0);
  });

  it("isolates rejection per seller group -- other sellers in the same call still claim", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller_full", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller_full", orderIds: ["ord_0"] }]);

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller_full", orderIds: ["ord_1"] },
      { sellerAccountId: "acc_seller_open", orderIds: ["ord_2"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual(["acc_seller_full"]);
    expect(await openClaimCount(db, "acc_seller_full")).toBe(1);
    expect(await openClaimCount(db, "acc_seller_open")).toBe(1);
  });

  it("races two concurrent claims for the last capacity slot -- exactly one wins, no deadlock", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);

    const [first, second] = await Promise.all([
      claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_a"] }]),
      claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_b"] }]),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.rejectedSellerAccountIds.length === 0);
    const losers = outcomes.filter((outcome) => outcome.rejectedSellerAccountIds.length > 0);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });

  it("releases idempotently -- a second release for the same order is a no-op", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);

    const releasedAt = new Date().toISOString();
    const firstRelease = await releaseSellerOrderCapacityClaim(db, "ord_1", releasedAt);
    const secondRelease = await releaseSellerOrderCapacityClaim(db, "ord_1", releasedAt);

    expect(firstRelease).toBe("acc_seller");
    expect(secondRelease).toBeNull();
    expect(await openClaimCount(db, "acc_seller")).toBe(0);
  });

  it("releasing an order that was never claimed is a no-op", async () => {
    const db = pools.ordering;

    const released = await releaseSellerOrderCapacityClaim(db, "ord_never_claimed", new Date().toISOString());

    expect(released).toBeNull();
  });

  it("frees the slot on release so a subsequent claim can succeed", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);

    const rejected = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_2"] }]);
    expect(rejected.rejectedSellerAccountIds).toEqual(["acc_seller"]);

    await releaseSellerOrderCapacityClaim(db, "ord_1", new Date().toISOString());

    const accepted = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_2"] }]);
    expect(accepted.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });

  it("reconciles at-capacity true once the open count reaches the cap", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);

    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });

    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);
    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: true });

    await releaseSellerOrderCapacityClaim(db, "ord_1", new Date().toISOString());
    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });
  });

  it("reconciles at-capacity false for an unlimited seller regardless of open count", async () => {
    const db = pools.ordering;

    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2", "ord_3"] }]);

    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });
  });

  it("backfill seeds claims from open orders idempotently, ignoring cancelled and dispatched ones", async () => {
    const db = pools.ordering;
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO ordering_order_pages (
         order_id, display_reference, source_type, source_reference_id, buyer_account_id, seller_account_id,
         shipping_option, item_subtotal_amount, shipping_base_amount, shipping_discount_amount,
         shipping_charge_amount, total_amount, marketplace_sales_fee_amount, seller_net_amount,
         terms_resolved_at, status, created_at, updated_at
       ) VALUES
         ('ord_open', 'CS-OPEN', 'cart-checkout', 'chk_1', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'pending-payment', $1, $1),
         ('ord_cancelled', 'CS-CANC', 'cart-checkout', 'chk_2', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'cancelled', $1, $1),
         ('ord_dispatched', 'CS-DISP', 'cart-checkout', 'chk_3', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'ready-for-fulfillment', $1, $1)`,
      [now],
    );
    await db.query(
      `INSERT INTO ordering_fulfillment_cancellation_inputs (
         order_id, shipment_id, shipment_status, package_status, created_at, updated_at
       ) VALUES ('ord_dispatched', 'shp_1', 'dispatched', 'packed', $1, $1)`,
      [now],
    );

    const firstRun = await backfillSellerOpenOrderClaims(db);
    expect(firstRun).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);

    const claimedOrderId = await db.query<{ order_id: string }>(
      `SELECT order_id FROM ordering_seller_open_order_claims WHERE seller_account_id = $1 AND status = 'claimed'`,
      ["acc_seller"],
    );
    expect(claimedOrderId.rows[0]?.order_id).toBe("ord_open");

    // Idempotent re-run: no duplicate rows, no error.
    const secondRun = await backfillSellerOpenOrderClaims(db);
    expect(secondRun).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as orderingModule } from "../../../index";
import { orderingOrderSchemaMigrations } from "../read-model/schema";
import { decrementPurchaseLimitUsage } from "./purchase-limits";
import { context, createCheckpointStore, createOrderingOrderRuntimeForTest } from "./runtime-test-harness";
import {
  bindEvidenceWindowSource,
  closeEvidenceWindowSource,
  observeEvidenceWindowSource,
  readEvidenceWindowSources,
  releaseEvidenceWindowSource,
  withOpenEvidenceWindowSource,
  type EvidenceWindowSourceIdentity,
  type EvidenceWindowSourceReleaseActions,
} from "./evidence-window-source-release";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;
const windowId = "abcdef0123456789abcdef0123456789";
const identity: EvidenceWindowSourceIdentity = {
  sourceType: "cart-checkout",
  sourceReferenceId: "chk_evidence_source",
  buyerAccountId: "acc_buyer",
};

describeDb("Ordering evidence-window source recovery DB", () => {
  let db: PgTransactionalPool;
  let pools: Readonly<Record<"ordering", PgTransactionalPool>>;
  let openedAt: string;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_evidence_sources");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    db = pools.ordering;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await db.query(orderingModule.schemaSql);
    openedAt = new Date().toISOString();
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  const actions: EvidenceWindowSourceReleaseActions = {
    readOrder: async () => "missing",
    readSellerSignal: async () => "converged",
    cancelOrder: async () => undefined,
    reconcileSeller: async () => undefined,
    decrementUsage: decrementPurchaseLimitUsage,
  };

  async function bind(sourceIdentity = identity) {
    return bindEvidenceWindowSource(db, { windowId, subInvocation: "2a", sourceIdentity, windowOpenedAt: openedAt });
  }
  async function close() {
    return closeEvidenceWindowSource(db, { windowId, subInvocation: "2a", expectedVersion: 1 });
  }
  async function release() {
    return releaseEvidenceWindowSource(db, { sourceIdentity: identity, windowOpenedAt: openedAt }, actions);
  }
  async function claim(status: "pending" | "claimed", listingId: string, quantity: number) {
    await db.query(
      `INSERT INTO ordering_listing_purchase_limit_claims
       (claim_id, source_type, source_reference_id, buyer_account_id, listing_id, quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `opl_${listingId}`,
        identity.sourceType,
        identity.sourceReferenceId,
        identity.buyerAccountId,
        listingId,
        quantity,
        status,
      ],
    );
    if (status === "claimed") {
      await db.query(
        `INSERT INTO ordering_listing_purchase_limit_usage
         (buyer_account_id, listing_id, marketplace_day, day_quantity, customer_account_quantity)
         VALUES ($1, $2, current_date, $3, $3)`,
        [identity.buyerAccountId, listingId, quantity],
      );
    }
  }

  it("AC-01 binds one immutable source/slot before a guarded first write, and rejects slot/account drift", async () => {
    expect((await bind()).outcome).toBe("bound");
    expect((await bind()).outcome).toBe("existing");
    expect((await bind({ ...identity, buyerAccountId: "acc_other" })).outcome).toBe("drift");
    await withOpenEvidenceWindowSource(db, identity, (client) =>
      client.query(
        `INSERT INTO ordering_order_source_claims
       (source_type, source_reference_id, buyer_account_id, order_ids, status)
       VALUES ($1, $2, $3, '["ord_claim"]'::jsonb, 'pending')`,
        [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
      ),
    );
    expect((await readEvidenceWindowSources(db, windowId))[0]?.sourceIdentity).toEqual(identity);
  });

  it("AC-02 stores no Order id in the source control record or terminal report", async () => {
    await bind();
    await close();
    const report = await release();
    expect(report?.outcome).toBe("discharged");
    const raw = await db.query<{ payload: string }>(
      `SELECT row_to_json(source)::text AS payload FROM ordering_evidence_window_sources AS source WHERE window_id = $1`,
      [windowId],
    );
    expect(raw.rows[0]?.payload).not.toContain("ord_planted_marker");
    expect(JSON.stringify(report)).not.toContain("ord_planted_marker");
  });

  it("AC-03 observes all five surfaces without issuing a write", async () => {
    await bind();
    await claim("pending", "lst_pending", 3);
    const queries: string[] = [];
    const readOnly = {
      query: async (sql: string, values?: readonly unknown[]) => {
        queries.push(sql);
        if (/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(sql)) throw new Error("observer wrote");
        return db.query(sql, values);
      },
    } as typeof db;
    const observed = await observeEvidenceWindowSource(readOnly, identity, actions);
    expect(observed?.outcome).toBe("owed");
    expect(queries.join("\n")).toMatch(/ordering_evidence_window_sources/);
    expect(queries.join("\n")).toMatch(/ordering_listing_purchase_limit_claims/);
    expect(queries.join("\n")).toMatch(/ordering_listing_purchase_limit_usage/);
    expect(queries.join("\n")).toMatch(/ordering_order_source_claims/);
  });

  it("AC-05/AC-12 releases an identity-only pending claim with bounded residue and no decrement", async () => {
    await bind();
    await claim("pending", "lst_residue", 4);
    await close();
    const report = await release();
    expect(report?.outcome).toBe("discharged-with-bounded-usage-residue");
    expect(report?.purchaseLimitResidue).toEqual([
      { listingId: "lst_residue", buyerAccountId: "acc_buyer", residueUpperBoundUnits: 4 },
    ]);
    const row = await db.query<{ status: string; usage_residue_upper_bound_units: number }>(
      `SELECT status, usage_residue_upper_bound_units FROM ordering_listing_purchase_limit_claims`,
    );
    expect(row.rows[0]).toMatchObject({ status: "released", usage_residue_upper_bound_units: 4 });
    expect(await release()).toEqual(report);
  });

  it.each([false, true])(
    "AC-12 historical synthetic pending pre/post-increment residue: increment=%s",
    async (incremented) => {
      await bind();
      await claim("pending", "lst_historical", 3);
      if (incremented) {
        await db.query(
          `INSERT INTO ordering_listing_purchase_limit_usage
         (buyer_account_id, listing_id, marketplace_day, day_quantity, customer_account_quantity)
         VALUES ('acc_buyer', 'lst_historical', current_date, 3, 3)`,
        );
      }
      await close();
      const report = await release();
      expect(report?.outcome).toBe("discharged-with-bounded-usage-residue");
      expect(report?.purchaseLimitResidue[0]?.residueUpperBoundUnits).toBe(3);
      const usage = await db.query<{ customer_account_quantity: number }>(
        `SELECT customer_account_quantity FROM ordering_listing_purchase_limit_usage`,
      );
      expect(usage.rows.map((row) => row.customer_account_quantity)).toEqual(incremented ? [3] : []);
    },
  );

  it("AC-07 close waits for a guarded creator and rejects its next transaction", async () => {
    await bind();
    let unblock!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const creator = withOpenEvidenceWindowSource(db, identity, async (client) => {
      entered();
      await held;
      await client.query(
        `INSERT INTO ordering_order_source_claims
         (source_type, source_reference_id, buyer_account_id, order_ids, status)
         VALUES ($1, $2, $3, '["ord_proposed"]'::jsonb, 'pending')`,
        [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
      );
    });
    await started;
    let closed = false;
    const closing = close().then((result) => {
      closed = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    unblock();
    await creator;
    expect((await closing).outcome).toBe("closed");
    await expect(withOpenEvidenceWindowSource(db, identity, async () => undefined)).rejects.toThrow(/closed/);
    expect((await release())?.surfaces.orderStreams).toBe("not-created");
    const events = await db.query(`SELECT 1 FROM event_store_events WHERE stream_id = 'ordering.order-ord_proposed'`);
    expect(events.rows).toHaveLength(0);
  });

  it("AC-08/AC-09 repeats claimed release without a second usage effect and replays a retained report", async () => {
    await bind();
    await claim("claimed", "lst_claimed", 5);
    await close();
    const first = await release();
    const second = await release();
    expect(first).toEqual(second);
    expect(first?.outcome).toBe("discharged");
    const usage = await db.query<{ day_quantity: number; customer_account_quantity: number }>(
      `SELECT day_quantity, customer_account_quantity FROM ordering_listing_purchase_limit_usage`,
    );
    expect(usage.rows[0]).toMatchObject({ day_quantity: 0, customer_account_quantity: 0 });
    const persisted = await db.query<{ terminal_report: unknown; discharged_at: Date }>(
      `SELECT terminal_report, discharged_at FROM ordering_evidence_window_sources`,
    );
    expect(persisted.rows[0]?.terminal_report).toEqual(first);
    expect(persisted.rows[0]?.discharged_at).toBeTruthy();
  });

  it("AC-13 recovers a capped seller after capacity flip/pre-reconcile and repeats its signal exactly once", async () => {
    await bind();
    await db.query(
      `INSERT INTO ordering_order_source_claims
       (source_type, source_reference_id, buyer_account_id, order_ids, status)
       VALUES ($1, $2, $3, '["ord_signal"]'::jsonb, 'pending')`,
      [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
    );
    await db.query(
      `INSERT INTO ordering_seller_order_capacity_inputs (seller_account_id, max_open_orders) VALUES ('acc_seller', 1)`,
    );
    await db.query(
      `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
       VALUES ('ord_signal', 'acc_seller', 'claimed', now())`,
    );
    const newRuntime = () =>
      createOrderingOrderRuntimeForTest({
        db,
        eventStore: createPostgresEventStore({ pool: db }),
        checkpointStore: createCheckpointStore(),
        shippingQuotePolicy: {
          quote: () => ({
            shippingOption: "standard",
            baseAmount: "0.00",
            discountAmount: "0.00",
            chargeAmount: "0.00",
          }),
        },
      });
    await newRuntime().reconcileSellerOrderCapacitySignal("acc_seller", context);
    await close();
    await expect(
      releaseEvidenceWindowSource(
        db,
        { sourceIdentity: identity, windowOpenedAt: openedAt },
        {
          ...actions,
          reconcileSeller: async () => {
            throw new Error("kill after capacity flip");
          },
        },
      ),
    ).rejects.toThrow("kill after capacity flip");
    expect((await db.query(`SELECT status FROM ordering_seller_open_order_claims`)).rows[0]).toMatchObject({
      status: "released",
    });
    expect((await db.query(`SELECT 1 FROM ordering_order_source_claims`)).rows).toHaveLength(1);
    const retry = await newRuntime().evidenceWindowSources.release({
      sourceIdentity: identity,
      windowOpenedAt: openedAt,
    });
    expect(retry?.outcome).toBe("discharged");
    expect(
      await newRuntime().evidenceWindowSources.release({ sourceIdentity: identity, windowOpenedAt: openedAt }),
    ).toEqual(retry);
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id = 'ordering.seller-capacity-acc_seller'
       ORDER BY stream_version`,
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "ordering.seller-capacity.reached",
      "ordering.seller-capacity.cleared",
    ]);
    expect((await db.query(`SELECT 1 FROM ordering_order_source_claims`)).rows).toHaveLength(0);
  });

  it("AC-09 keeps the root while an Order surface is owed and finalizes under CAS", async () => {
    await bind();
    await db.query(
      `INSERT INTO ordering_order_source_claims
       (source_type, source_reference_id, buyer_account_id, order_ids, status)
       VALUES ($1, $2, $3, '["ord_owed"]'::jsonb, 'pending')`,
      [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
    );
    await db.query(
      `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
       VALUES ('ord_owed', 'acc_seller', 'claimed', now())`,
    );
    await close();
    const blocked = await releaseEvidenceWindowSource(
      db,
      { sourceIdentity: identity, windowOpenedAt: openedAt },
      {
        ...actions,
        readOrder: async () => "live",
      },
    );
    expect(blocked?.outcome).toBe("owed");
    expect((await db.query(`SELECT 1 FROM ordering_order_source_claims`)).rows).toHaveLength(1);
    const results = await Promise.all([release(), release()]);
    expect(results[0]).toEqual(results[1]);
    expect((await db.query(`SELECT 1 FROM ordering_order_source_claims`)).rows).toHaveLength(0);
  });

  it("AC-14 validates residue bounds and fresh/upgrade/reapply schema parity", async () => {
    const migration = orderingOrderSchemaMigrations.find(
      (item) => item.migrationId === "20260926_ordering_evidence_window_sources",
    );
    expect(migration?.statements[0]).toContain("SET LOCAL lock_timeout = '5s'");
    await db.query(migration!.statements[0]!);
    await db.query(migration!.statements[0]!);
    for (const bad of [0, -1, 6]) {
      await expect(
        db.query(
          `INSERT INTO ordering_listing_purchase_limit_claims
         (claim_id, source_type, source_reference_id, buyer_account_id, listing_id, quantity, status,
          usage_residue_upper_bound_units)
         VALUES ($1, 'cart-checkout', 'chk_bad', 'acc_buyer', 'lst_bad', 5, 'released', $2)`,
          [`opl_bad_${bad}`, bad],
        ),
      ).rejects.toThrow();
    }
    expect((await db.query(`SELECT 1 FROM ordering_listing_purchase_limit_claims`)).rows).toHaveLength(0);
  });
});

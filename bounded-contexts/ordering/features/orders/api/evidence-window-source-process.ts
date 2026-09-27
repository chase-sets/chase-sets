import {
  createMultiContextTestPools,
  closeMultiContextTestPools,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createOrderingOrderRuntime } from "./runtime";

const databaseUrl = process.env.TEST_SOURCE_DB_URL;
const windowOpenedAt = process.env.TEST_SOURCE_OPENED_AT;
if (!databaseUrl || !windowOpenedAt) process.exit(2);

const pools = createMultiContextTestPools({ ordering: databaseUrl });
try {
  const db = pools.ordering;
  const cut = process.env.TEST_SOURCE_CUT;
  const releaseCut = process.env.TEST_SOURCE_RELEASE_CUT;
  const sourceReferenceId = process.env.TEST_SOURCE_REFERENCE_ID ?? "chk_fresh_process";
  let sourceInserted = false;
  let usageFlipped = false;
  let sourceCompleted = false;
  let capacityInserts = 0;
  let rootDeleted = false;
  const pause = async (name: string) => {
    if (cut !== name && releaseCut !== name) return;
    process.stdout.write(`CUT:${name}\n`);
    await new Promise<void>(() => undefined);
  };
  const afterQuery = async (sql: string) => {
    if (releaseCut && sql.includes("UPDATE ordering_evidence_window_sources") && sql.includes("SET discharged_at"))
      await pause("after reconcile/pre-root delete");
    if (releaseCut && sql.includes("DELETE FROM ordering_order_source_claims")) rootDeleted = true;
    if (sql.includes("INSERT INTO ordering_order_source_claims")) sourceInserted = true;
    if (sql.includes("INSERT INTO ordering_listing_purchase_limit_claims")) await pause("claim-insert/pre-increment");
    if (sql.includes("SET day_quantity = day_quantity +")) await pause("increment/pre-flip");
    if (sql.includes("UPDATE ordering_listing_purchase_limit_claims") && sql.includes("SET status = 'claimed'")) {
      usageFlipped = true;
    }
    if (sql.includes("INSERT INTO ordering_seller_open_order_claims")) {
      capacityInserts++;
      if (capacityInserts === 2) await pause("capacity/pre-Order");
    }
    if (sql.includes("UPDATE ordering_order_source_claims") && sql.includes("SET order_ids")) sourceCompleted = true;
    if (sql.trim() === "COMMIT") {
      if (rootDeleted) await pause("after root delete/pre-runner outcome");
      if (sourceInserted) {
        sourceInserted = false;
        await pause("source/pre-usage");
      }
      if (usageFlipped) {
        usageFlipped = false;
        await pause("usage/pre-capacity");
      }
      if (cut === "between Orders" || cut === "last Order/pre-complete") {
        const orders = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM event_store_events WHERE stream_id LIKE 'ordering.order-%'`,
        );
        if (Number(orders.rows[0]?.n) === (cut === "between Orders" ? 1 : 2)) await pause(cut);
      }
      if (sourceCompleted) {
        sourceCompleted = false;
        await pause("complete/pre-response");
      }
    }
  };
  const wrapped: PgTransactionalPool = {
    query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      const result = await db.query<Row>(sql, values);
      await afterQuery(sql);
      return result;
    },
    connect: async () => {
      const client = await db.connect();
      const query: PgQueryable["query"] = async <Row = Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[],
      ) => {
        const result = await client.query<Row>(sql, values);
        await afterQuery(sql);
        return result;
      };
      return { query, release: client.release.bind(client) };
    },
  };
  const runtime = createOrderingOrderRuntime({
    db: wrapped,
    eventStore: createPostgresEventStore({ pool: wrapped }),
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    inventoryCleanupAuthority: { kind: "not-mounted" },
    shippingQuotePolicy: {
      quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
    },
  });
  if (cut) {
    await pause("pre-source");
    await runtime.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_buyer" as AccountId,
        checkoutSessionId: sourceReferenceId,
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress: {
          name: "Buyer",
          company: null,
          line1: "100 Market Street",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          phone: null,
          email: null,
        },
        lines: ["lst_a", "lst_b"].map((listingId) => ({
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
        evidenceWindowSource: {
          windowId: "fedcba9876543210fedcba9876543210",
          subInvocation: "2a",
          windowOpenedAt,
        },
      },
      {
        tenantId: "tnt_test" as TenantId,
        audit: { performedByUserId: "usr_test" as UserId, forAccountId: "acc_buyer" as AccountId },
      },
    );
    process.stdout.write("UNEXPECTED_COMPLETION\n");
  } else {
    const report = await runtime.evidenceWindowSources.release({
      sourceIdentity: { sourceType: "cart-checkout", sourceReferenceId, buyerAccountId: "acc_buyer" },
      windowOpenedAt,
    });
    process.stdout.write(JSON.stringify({ outcome: report?.outcome ?? null }) + "\n");
  }
} finally {
  await closeMultiContextTestPools(pools);
}

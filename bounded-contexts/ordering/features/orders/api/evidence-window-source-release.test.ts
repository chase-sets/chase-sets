import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryResult, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  SELLER_ACCOUNT_ID,
  createStubInventoryAuthority,
  orderCreatedPayload,
  type StubInventoryAuthority,
} from "../../../tests/test-support/cleanup-authority";
import { releaseEvidenceWindowSource, type EvidenceWindowSourceReleaseActions } from "./evidence-window-source-release";
import { createCheckpointStore, createOrderingOrderRuntimeForTest } from "./runtime-test-harness";

// Synthetic controls: the ledger rows below are routed in memory, and every
// identity is labeled synthetic. The DB-backed counterparts live in
// evidence-window-source-release.db.test.ts.
const identity = {
  sourceType: "cart-checkout",
  sourceReferenceId: "chk_synthetic_recovery",
  buyerAccountId: "acc_synthetic_buyer",
} as const;
const orderId = "ord_synthetic_recovery";
const openedAt = new Date(Date.now() - 1000).toISOString();
const input = { sourceIdentity: identity, windowOpenedAt: openedAt };

function syntheticLedger(options: Readonly<{ capacity: boolean; purchase: boolean }>) {
  const source = {
    window_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sub_invocation: "2a",
    source_type: identity.sourceType,
    source_reference_id: identity.sourceReferenceId,
    buyer_account_id: identity.buyerAccountId,
    window_opened_at: openedAt,
    creator_state: "closed",
    discharged_at: null as string | null,
    terminal_report: null as unknown,
    version: 2,
  };
  const state = { rootPresent: true, capacityStatus: "claimed", capacityWrites: 0, purchaseStatus: "claimed" };
  const purchaseRow = () => ({
    listing_id: "lst_synthetic_recovery",
    quantity: 3,
    status: state.purchaseStatus,
    usage_residue_upper_bound_units: null,
    claimed_day: openedAt.slice(0, 10),
  });
  const route = (sql: string, values?: readonly unknown[]): readonly unknown[] | number => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return [];
    if (sql.includes("UPDATE ordering_evidence_window_sources")) {
      source.terminal_report = JSON.parse(String(values?.[2]));
      source.discharged_at = new Date().toISOString();
      source.version++;
      return 1;
    }
    if (sql.includes("DELETE FROM ordering_order_source_claims")) {
      state.rootPresent = false;
      return 1;
    }
    if (sql.includes("UPDATE ordering_seller_open_order_claims")) {
      state.capacityWrites++;
      state.capacityStatus = "released";
      return 1;
    }
    if (sql.includes("UPDATE ordering_listing_purchase_limit_claims")) {
      if (!options.purchase || state.purchaseStatus === "released") return [];
      state.purchaseStatus = "released";
      return [purchaseRow()];
    }
    if (sql.includes("FROM ordering_evidence_window_sources")) return [source];
    if (sql.includes("FROM ordering_listing_purchase_limit_claims")) return options.purchase ? [purchaseRow()] : [];
    if (sql.includes("FROM ordering_listing_purchase_limit_usage"))
      return options.purchase ? [{ listing_id: "lst_synthetic_recovery" }] : [];
    if (sql.includes("FROM ordering_order_source_claims"))
      return state.rootPresent ? [{ order_ids: [orderId], status: "pending" }] : [];
    if (sql.includes("FROM ordering_seller_open_order_claims"))
      return options.capacity
        ? [{ order_id: orderId, seller_account_id: "acc_synthetic_seller", status: state.capacityStatus }]
        : [];
    throw new Error(`Unexpected synthetic query: ${sql}`);
  };
  async function query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>> {
    const routed = route(sql, values);
    return typeof routed === "number"
      ? { rows: [], rowCount: routed }
      : { rows: routed as Row[], rowCount: routed.length };
  }
  const db: PgTransactionalPool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { db, source, state };
}

const syntheticContext: EventStoreContext = {
  tenantId: "tnt_synthetic" as TenantId,
  audit: { performedByUserId: "usr_synthetic" as UserId, forAccountId: identity.buyerAccountId as AccountId },
};

function runtimeFor(ledger: ReturnType<typeof syntheticLedger>, inventory?: StubInventoryAuthority) {
  const { eventStore } = createInMemoryEventStore();
  const runtime = createOrderingOrderRuntimeForTest({
    db: ledger.db,
    eventStore,
    checkpointStore: createCheckpointStore(),
    shippingQuotePolicy: {
      quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
    },
    ...(inventory ? { inventoryCleanupAuthority: { kind: "available" as const, port: inventory } } : {}),
  });
  return { eventStore, runtime };
}

describe("Ordering evidence-window source release authority (synthetic)", () => {
  it.each(["unknown", "read failure", "unknown after cancel"] as const)(
    "F1 %s Order authority releases no purchase usage or seller capacity",
    async (authority) => {
      const ledger = syntheticLedger({ capacity: true, purchase: true });
      let cancels = 0;
      let reconciles = 0;
      let decrementedUnits = 0;
      const actions: EvidenceWindowSourceReleaseActions = {
        readOrder: async () => {
          if (authority === "read failure") throw new Error("synthetic order read unavailable");
          return authority === "unknown after cancel" && cancels === 0 ? "live" : "unknown";
        },
        readSellerSignal: async () => "converged",
        cancelOrder: async () => {
          cancels++;
        },
        reconcileSeller: async () => {
          reconciles++;
        },
        decrementUsage: async (_client, _buyer, claims) => {
          decrementedUnits += claims.reduce((sum, claim) => sum + claim.quantity, 0);
        },
      };
      const report = await releaseEvidenceWindowSource(ledger.db, input, actions);
      expect(report?.outcome).toBe("unknown");
      expect(cancels).toBe(authority === "unknown after cancel" ? 1 : 0);
      expect(decrementedUnits).toBe(0);
      expect(reconciles).toBe(0);
      expect(ledger.state).toMatchObject({
        rootPresent: true,
        capacityStatus: "claimed",
        capacityWrites: 0,
        purchaseStatus: "claimed",
      });
      expect(ledger.source.terminal_report).toBeNull();
      expect(ledger.source.discharged_at).toBeNull();
    },
  );

  it("F1 real runtime retains usage and capacity for a captured-remedy-required Order", async () => {
    const ledger = syntheticLedger({ capacity: true, purchase: true });
    const inventory = createStubInventoryAuthority({});
    const { eventStore, runtime } = runtimeFor(ledger, inventory);
    const at = new Date().toISOString();
    await eventStore.appendToStream({
      streamId: `ordering.order-${orderId}`,
      expectedVersion: "no_stream",
      context: syntheticContext,
      events: [
        {
          eventType: "ordering.order.created",
          payload: orderCreatedPayload({
            orderId,
            buyerAccountId: identity.buyerAccountId,
            sourceReferenceId: identity.sourceReferenceId,
          }) as JsonObject,
        },
        {
          eventType: "ordering.order.reservation-confirmed",
          payload: {
            orderId,
            reservationRequestId: "rsv_1",
            inventoryItemId: "inv_1",
            sellerAccountId: SELLER_ACCOUNT_ID,
            quantity: 1,
            holdId: "hld_1",
            confirmedAt: at,
          },
        },
        {
          eventType: "ordering.order.pending-payment-recorded",
          payload: {
            orderId,
            pendingPaymentAt: at,
            paymentDeadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
            paymentDeadlinePolicy: "standard",
          },
        },
        {
          eventType: "ordering.order.ready-for-fulfillment-recorded",
          payload: { orderId, readyForFulfillmentAt: at },
        },
      ],
    });
    const report = await runtime.evidenceWindowSources.release(input);
    expect(report?.outcome).toBe("unknown");
    expect(report?.surfaces.orderStreams).toBe("unknown");
    expect(await eventStore.readStream({ streamId: `ordering.order-${orderId}` })).toHaveLength(4);
    expect([...inventory.reservationCalls, ...inventory.holdCalls, ...inventory.lookupCalls]).toEqual([]);
    expect(ledger.state).toMatchObject({
      rootPresent: true,
      capacityStatus: "claimed",
      capacityWrites: 0,
      purchaseStatus: "claimed",
    });
    expect(ledger.source.terminal_report).toBeNull();
    expect(ledger.source.discharged_at).toBeNull();
  });

  it("F2 real runtime reads a nonempty Order stream without creation as unknown, never not-created", async () => {
    const ledger = syntheticLedger({ capacity: true, purchase: true });
    const { eventStore, runtime } = runtimeFor(ledger);
    await eventStore.appendToStream({
      streamId: `ordering.order-${orderId}`,
      expectedVersion: "no_stream",
      context: syntheticContext,
      events: [{ eventType: "ordering.order.line-item-amounts-published", payload: { orderId, lineItems: [] } }],
    });
    const report = await runtime.evidenceWindowSources.release(input);
    expect(report?.outcome).toBe("unknown");
    expect(report?.surfaces.orderStreams).toBe("unknown");
    expect(
      (await eventStore.readStream({ streamId: `ordering.order-${orderId}` })).map((event) => event.eventType),
    ).toEqual(["ordering.order.line-item-amounts-published"]);
    expect(ledger.state).toMatchObject({
      rootPresent: true,
      capacityStatus: "claimed",
      capacityWrites: 0,
      purchaseStatus: "claimed",
    });
    expect(ledger.source.terminal_report).toBeNull();
    expect(ledger.source.discharged_at).toBeNull();
  });

  it("F2 control: a genuinely absent Order is not-created and its report replays", async () => {
    const ledger = syntheticLedger({ capacity: false, purchase: false });
    const { eventStore, runtime } = runtimeFor(ledger);
    const report = await runtime.evidenceWindowSources.release(input);
    expect(report?.outcome).toBe("discharged");
    expect(report?.surfaces.orderStreams).toBe("not-created");
    expect(ledger.state.rootPresent).toBe(false);
    expect(await eventStore.readStream({ streamId: `ordering.order-${orderId}` })).toEqual([]);
    expect(await runtime.evidenceWindowSources.release(input)).toEqual(report);
  });
});

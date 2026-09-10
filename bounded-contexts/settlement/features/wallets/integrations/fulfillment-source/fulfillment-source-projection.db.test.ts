import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  createSubscriptionRunner,
  drainLocalProjectionHandlerSets,
  drainSubscriptionRunners,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventRecordToStore } from "@chase-sets/event-core/storage";
import { module as settlementModule } from "../../../../index";
import type { SettlementServices } from "../../../../support/runtime-support/services";
import { MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE } from "./label-postage-policy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["source", "settlement"] as const;

const sourceModule = defineBoundedContextModule({
  manifest: { contextName: "source", apiBasePath: "/source", streamPrefix: "source." },
  schemaSql: "",
  createServices: (pool: PgTransactionalPool) => ({ pool }),
  buildApis: () => [],
});

type TestRuntime = Readonly<{
  services: SettlementServices;
  fulfillmentRunner: ReturnType<typeof createSubscriptionRunner>;
  paymentsRunner: ReturnType<typeof createSubscriptionRunner>;
}>;

type LedgerRow = Readonly<{
  ledger_entry_id: string;
  kind: string;
  direction: string;
  amount: string;
  funds_status: string;
  order_id: string | null;
  description: string | null;
}>;

type PostageRow = Readonly<{
  shipment_id: string;
  postage_provider_label_id: string | null;
  outcome: string;
  operator_review_required: boolean;
  debit_ledger_entry_id: string | null;
  refund_ledger_entry_id: string | null;
  refund_reference: string | null;
  refund_status: string | null;
}>;

function projectionRunContext(ownerId: string) {
  return { ownerId, fencingToken: "1", throwIfLeaseLost: () => undefined };
}

function eventStoreContext() {
  return {
    tenantId: "tnt_test" as never,
    audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
  };
}

function created(shipmentId: string, orderId = `ord_${shipmentId}`) {
  return {
    eventType: "fulfillment.shipment.created",
    payload: {
      shipmentId,
      orderId,
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      createdAt: "2026-09-10T15:47:00.000Z",
    },
  };
}

function labelAttached(
  shipmentId: string,
  providerLabelId: string | null,
  amountCents: number | null,
  currency = "usd",
) {
  return {
    eventType: "fulfillment.shipment.label-attached",
    payload: {
      shipmentId,
      postageProviderLabelId: providerLabelId,
      postageAmountCents: amountCents,
      postageCurrency: currency,
      attachedAt: "2026-09-10T15:48:00.000Z",
    },
  };
}

function labelVoided(shipmentId: string, refundReference: string, refundStatus = "submitted") {
  return {
    eventType: "fulfillment.shipment.label-voided",
    payload: {
      shipmentId,
      refundStatus,
      refundReference,
      voidedAt: "2026-09-10T15:49:00.000Z",
    },
  };
}

function refundStatus(shipmentId: string, refundReference: string, status: string) {
  return {
    eventType: "fulfillment.shipment.label-refund-status-recorded",
    payload: {
      shipmentId,
      refundStatus: status,
      refundReference,
      resolvedAt: "2026-09-10T15:50:00.000Z",
    },
  };
}

describeDb("marketplace label postage Settlement integration", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let sourceEventSequence = 0;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "marketplace_label_postage");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(sourceModule, pools.source);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
    sourceEventSequence = 0;
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  function createRuntime(): TestRuntime {
    const services = settlementModule.createServices(createProjectionAwarePool(pools.settlement), {});
    const subscriptions = settlementModule.buildSubscriptions?.(services) ?? [];
    const fulfillment = subscriptions.find(
      (candidate) =>
        candidate.sourceContextName === "fulfillment" &&
        candidate.projectionName === "settlement-fulfillment-source-projection",
    );
    const payments = subscriptions.find(
      (candidate) =>
        candidate.sourceContextName === "payments" &&
        candidate.projectionName === "settlement-payment-input-projection",
    );
    if (!fulfillment || !payments) throw new Error("Settlement source subscriptions are not registered.");

    return {
      services,
      fulfillmentRunner: createSubscriptionRunner("settlement", pools.settlement, pools.source, fulfillment),
      paymentsRunner: createSubscriptionRunner("settlement", pools.settlement, pools.source, payments),
    };
  }

  async function appendEvents(
    streamId: string,
    events: readonly Readonly<{ eventType: string; payload: Record<string, unknown> }>[],
    recordedAts: readonly string[] | string = "2026-09-10T15:46:53.000Z",
  ): Promise<void> {
    const records = events.map((event) => ({
      ...event,
      eventId: `evt_postage_${++sourceEventSequence}` as never,
      occurredAt: String(
        event.payload.attachedAt ??
          event.payload.resolvedAt ??
          event.payload.voidedAt ??
          event.payload.capturedAt ??
          event.payload.createdAt,
      ) as never,
    }));
    const eventStore = createPostgresEventStore({ pool: pools.source });
    let stored: Awaited<ReturnType<typeof eventStore.appendToStream>>;
    try {
      stored = await eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context: eventStoreContext(),
        events: records as readonly EventRecordToStore[],
      });
    } catch (error) {
      const details =
        typeof error === "object" && error !== null && "details" in error
          ? JSON.stringify((error as { details?: unknown }).details)
          : "none";
      throw new Error(`Source fixture append failed for ${streamId}; details=${details}`, { cause: error });
    }
    const times = typeof recordedAts === "string" ? stored.map(() => recordedAts) : recordedAts;
    for (const [index, event] of stored.entries()) {
      await pools.source.query("UPDATE event_store_events SET recorded_at = $2 WHERE event_id = $1", [
        event.eventId,
        times[index],
      ]);
    }
  }

  async function appendPaymentCapture(orderId: string): Promise<void> {
    await appendEvents("payments.payment-pay_postage", [
      {
        eventType: "payments.payment-created",
        payload: {
          paymentId: "pay_postage",
          buyerAccountId: "acc_buyer",
          orderIds: [orderId],
          sellerPayouts: [
            {
              orderId,
              sellerAccountId: "acc_seller",
              sellerItemNetAmount: "10.00",
              shippingAllowanceAmount: "0.00",
              sellerShippingPayoutAmount: "0.00",
              sellerPayoutAmount: "10.00",
            },
          ],
          amount: "10.00",
          balanceCreditAmount: "0.00",
          processorAmount: "10.00",
          marketplaceSalesFeeAmount: "0.00",
          currencyCode: "usd",
          processorName: "stripe",
          processorPaymentReference: "pi_postage",
          processorStatus: "requires_capture",
          createdAt: "2026-09-10T15:51:00.000Z",
        },
      },
      {
        eventType: "payments.payment-captured",
        payload: {
          paymentId: "pay_postage",
          buyerAccountId: "acc_buyer",
          balanceCreditAmount: "0.00",
          currencyCode: "usd",
          processorStatus: "succeeded",
          capturedAt: "2026-09-10T15:52:00.000Z",
          sellerPayouts: [
            {
              orderId,
              sellerAccountId: "acc_seller",
              sellerItemNetAmount: "10.00",
              shippingAllowanceAmount: "0.00",
              sellerShippingPayoutAmount: "0.00",
              sellerPayoutAmount: "10.00",
            },
          ],
        },
      },
    ]);
  }

  async function drain(runner: ReturnType<typeof createSubscriptionRunner>, ownerId: string): Promise<void> {
    await drainSubscriptionRunners([runner], projectionRunContext(ownerId));
  }

  async function projectWallet(runtime: TestRuntime): Promise<void> {
    await drainLocalProjectionHandlerSets(
      "settlement",
      pools.settlement,
      runtime.services.projectors,
      projectionRunContext("postage-local-projections"),
    );
  }

  async function ledgerRows(): Promise<readonly LedgerRow[]> {
    const result = await pools.settlement.query<LedgerRow>(
      `SELECT ledger_entry_id, kind, direction, amount::text AS amount, funds_status, order_id, description
       FROM settlement_ledger_entry_pages
       WHERE account_id = 'acc_seller'
       ORDER BY posted_at, ledger_entry_id`,
    );
    return result.rows;
  }

  async function postageRows(): Promise<readonly PostageRow[]> {
    const result = await pools.settlement.query<PostageRow>(
      `SELECT shipment_id, postage_provider_label_id, outcome, operator_review_required,
              debit_ledger_entry_id, refund_ledger_entry_id, refund_reference, refund_status
       FROM settlement_marketplace_label_postage
       ORDER BY shipment_id, label_attached_at, label_identity`,
    );
    return result.rows;
  }

  it("label-postage-debit-once: serializes concurrent runners, duplicate facts, and projection replay", async () => {
    await appendEvents("fulfillment.shipment-shp_once", [
      created("shp_once"),
      labelAttached("shp_once", "pl_once", 525),
      labelAttached("shp_once", "pl_once", 525),
    ]);
    const first = createRuntime();
    const second = createRuntime();

    await Promise.all([
      first.fulfillmentRunner.runOnce(projectionRunContext("postage-concurrent-a")),
      second.fulfillmentRunner.runOnce(projectionRunContext("postage-concurrent-b")),
    ]);
    await drain(first.fulfillmentRunner, "postage-concurrent-finish");
    await projectWallet(first);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect(await postageRows()).toHaveLength(1);

    await pools.settlement.query("TRUNCATE settlement_marketplace_label_postage");
    await first.fulfillmentRunner.reset(projectionRunContext("postage-rebuild"));
    await drain(first.fulfillmentRunner, "postage-replay");
    await projectWallet(first);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect(await postageRows()).toHaveLength(1);
  });

  it("label-postage-negative-offset: allows the debit and offsets it before release hold", async () => {
    const orderId = "ord_negative_offset";
    await appendEvents("fulfillment.shipment-shp_negative", [
      created("shp_negative", orderId),
      labelAttached("shp_negative", "pl_negative", 500),
    ]);
    const runtime = createRuntime();
    await drain(runtime.fulfillmentRunner, "postage-negative-debit");
    await projectWallet(runtime);

    const afterDebit = await runtime.services.wallets.getWallet("acc_seller");
    expect(afterDebit.available_balance_amount).toBe("-5.00");
    expect(afterDebit.negative_balance_status).toBe("negative");

    await appendPaymentCapture(orderId);
    await drain(runtime.paymentsRunner, "postage-negative-offset");
    await projectWallet(runtime);

    const afterProceeds = await runtime.services.wallets.getWallet("acc_seller");
    expect(afterProceeds.available_balance_amount).toBe("0.00");
    expect(afterProceeds.pending_balance_amount).toBe("5.00");
    expect(afterProceeds.negative_balance_status).toBe("in-good-standing");
    expect(await ledgerRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "debit", amount: "5.00", funds_status: "available" }),
        expect.objectContaining({ direction: "credit", amount: "5.00", funds_status: "available" }),
        expect.objectContaining({ direction: "credit", amount: "5.00", funds_status: "pending" }),
      ]),
    );
  });

  it("label-postage-refund-credit: links one opposite entry to the right debit across rebuy and replay", async () => {
    await appendEvents("fulfillment.shipment-shp_refund", [
      created("shp_refund"),
      labelAttached("shp_refund", "pl_first", 425),
      labelVoided("shp_refund", "rfnd_first"),
      labelAttached("shp_refund", "pl_rebuy", 650),
      refundStatus("shp_refund", "rfnd_first", "refunded"),
      labelVoided("shp_refund", "rfnd_rebuy"),
      refundStatus("shp_refund", "rfnd_rebuy", "rejected"),
      refundStatus("shp_refund", "rfnd_first", "refunded"),
    ]);
    const runtime = createRuntime();
    await drain(runtime.fulfillmentRunner, "postage-refund");
    await projectWallet(runtime);

    const ledger = await ledgerRows();
    expect(ledger.filter((row) => row.direction === "debit")).toHaveLength(2);
    expect(ledger.filter((row) => row.direction === "credit")).toEqual([
      expect.objectContaining({
        kind: "platform-purchase",
        amount: "4.25",
        order_id: "ord_shp_refund",
        description: expect.stringContaining("shipment shp_refund"),
      }),
    ]);

    const rows = await postageRows();
    const first = rows.find((row) => row.postage_provider_label_id === "pl_first")!;
    const rebuy = rows.find((row) => row.postage_provider_label_id === "pl_rebuy")!;
    expect(first.refund_reference).toBe("rfnd_first");
    expect(first.refund_status).toBe("refunded");
    expect(first.refund_ledger_entry_id).not.toBeNull();
    expect(first.refund_ledger_entry_id).not.toBe(first.debit_ledger_entry_id);
    expect(rebuy.refund_status).toBe("rejected");
    expect(rebuy.refund_ledger_entry_id).toBeNull();
  });

  it("label-postage-skip-and-refuse: records typed outcomes and no money movement", async () => {
    await appendEvents("fulfillment.shipment-shp_null", [created("shp_null"), labelAttached("shp_null", null, null)]);
    await appendEvents("fulfillment.shipment-shp_currency", [
      created("shp_currency"),
      labelAttached("shp_currency", "pl_currency", 500, "cad"),
    ]);
    const runtime = createRuntime();
    await drain(runtime.fulfillmentRunner, "postage-skip-refuse");
    await projectWallet(runtime);

    expect(await ledgerRows()).toEqual([]);
    expect(await postageRows()).toEqual([
      expect.objectContaining({
        shipment_id: "shp_currency",
        outcome: "refused-currency-mismatch",
        operator_review_required: true,
      }),
      expect.objectContaining({
        shipment_id: "shp_null",
        outcome: "skipped-null-amount",
        operator_review_required: false,
      }),
    ]);
  });

  it("label-postage-cutover: excludes the last historical instant and includes the boundary", async () => {
    const cutover = MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE.cutoverRecordedAt;
    await appendEvents(
      "fulfillment.shipment-shp_historical",
      [created("shp_historical"), labelAttached("shp_historical", "pl_historical", 400)],
      ["2026-09-10T15:46:51.000Z", "2026-09-10T15:46:51.999Z"],
    );
    await appendEvents(
      "fulfillment.shipment-shp_boundary",
      [created("shp_boundary"), labelAttached("shp_boundary", "pl_boundary", 450)],
      ["2026-09-10T15:46:51.000Z", cutover],
    );
    const runtime = createRuntime();
    await drain(runtime.fulfillmentRunner, "postage-cutover");
    await projectWallet(runtime);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toEqual([
      expect.objectContaining({ amount: "4.50", order_id: "ord_shp_boundary" }),
    ]);
    expect((await postageRows()).map((row) => [row.shipment_id, row.outcome])).toEqual([
      ["shp_boundary", "debit-posted"],
      ["shp_historical", "skipped-historical"],
    ]);
  });

  it("label-postage-statement: renders the shipment reference through the existing statement query", async () => {
    await appendEvents("fulfillment.shipment-shp_statement", [
      created("shp_statement"),
      labelAttached("shp_statement", "pl_statement", 575),
    ]);
    const runtime = createRuntime();
    await drain(runtime.fulfillmentRunner, "postage-statement");
    await projectWallet(runtime);

    const statement = await runtime.services.wallets.listWalletEntries({ accountId: "acc_seller" });
    expect(statement.total).toBe(1);
    expect(statement.items).toEqual([
      expect.objectContaining({
        kind: "platform-purchase",
        direction: "debit",
        amount: "5.75",
        order_id: "ord_shp_statement",
        description: "Marketplace label postage for shipment shp_statement",
      }),
    ]);
  });
});

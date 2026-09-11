import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventRecordToStore } from "@chase-sets/event-core/storage";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as settlementModule } from "../../../../index";
import type { SettlementServices } from "../../../../support/runtime-support/services";
import {
  activateMarketplaceLabelPostage,
  MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
  readMarketplaceLabelPostageActivation,
  validateMarketplaceLabelPostageActivation,
  type MarketplaceLabelPostageActivation,
} from "./label-postage-policy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["fulfillment", "settlement"] as const;

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
    await bootstrapContextDatabase(fulfillmentModule, pools.fulfillment);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
    sourceEventSequence = 0;
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  async function createRuntime(activation?: MarketplaceLabelPostageActivation): Promise<TestRuntime> {
    const resolvedActivation = activation ?? (await activateMarketplaceLabelPostage(pools.settlement));
    const services = settlementModule.createServices(createProjectionAwarePool(pools.settlement), {
      marketplaceLabelPostageActivation: resolvedActivation,
    });
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
      fulfillmentRunner: createSubscriptionRunner("settlement", pools.settlement, pools.fulfillment, fulfillment),
      paymentsRunner: createSubscriptionRunner("settlement", pools.settlement, pools.fulfillment, payments),
    };
  }

  async function appendEvents(
    streamId: string,
    events: readonly Readonly<{ eventType: string; payload: Record<string, unknown> }>[],
    recordedAts: readonly string[] | string | null = "2100-01-01T00:00:00.000Z",
  ) {
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
    const eventStore = createPostgresEventStore({ pool: pools.fulfillment });
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
    if (recordedAts === null) return stored;
    const times = typeof recordedAts === "string" ? stored.map(() => recordedAts) : recordedAts;
    for (const [index, event] of stored.entries()) {
      await pools.fulfillment.query("UPDATE event_store_events SET recorded_at = $2 WHERE event_id = $1", [
        event.eventId,
        times[index],
      ]);
    }
    return stored;
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

  async function produceRefundSequence(
    input: Readonly<{
      shipmentId: string;
      amountCents: number;
      mode: "immediate" | "submitted" | "late-after-rebuy" | "rejected";
    }>,
  ) {
    const services = fulfillmentModule.createServices(createProjectionAwarePool(pools.fulfillment), {});
    const context = eventStoreContext();
    const streamId = `fulfillment.shipment-${input.shipmentId}`;
    const labelA = `synthetic_label_A_${input.shipmentId}`;
    const labelB = `synthetic_label_B_${input.shipmentId}`;
    const refundReference = `synthetic_refund_A_${input.shipmentId}`;
    const command = (value: Record<string, unknown>) =>
      services.shipments.commandHandler({ streamId, context, command: value as never });

    await command({
      type: "CreateShipment",
      shipmentId: input.shipmentId,
      orderId: `ord_${input.shipmentId}`,
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      shippingOption: "standard",
      shippingDestinationSnapshot: {
        name: "Synthetic Buyer",
        line1: "2 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      shippingOriginSnapshot: {
        name: "Synthetic Seller",
        line1: "1 Test St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      lines: [
        {
          lineId: `spl_${input.shipmentId}`,
          orderLineId: `oli_${input.shipmentId}`,
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          itemTitle: "Synthetic card",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    await command({ type: "StartShipmentPacking", startedAt: "2030-01-01T00:00:10.000Z" });
    await command({
      type: "ConfirmShipmentPackingLine",
      lineId: `spl_${input.shipmentId}`,
      confirmedAt: "2030-01-01T00:00:20.000Z",
    });
    await command({ type: "PrepareShipmentPackage", packageCount: 1, preparedAt: "2030-01-01T00:00:30.000Z" });
    await command({
      type: "AttachShipmentLabel",
      shippingMethod: "standard",
      carrierName: "USPS",
      labelReference: labelA,
      trackingIdentifier: `synthetic_tracking_A_${input.shipmentId}`,
      postageProviderName: "synthetic-postage",
      postageProviderMode: "test",
      postageProviderShipmentId: `synthetic_shipment_A_${input.shipmentId}`,
      postageProviderLabelId: labelA,
      postageAmountCents: input.amountCents,
      postageCurrency: "USD",
      attachedAt: "2030-01-01T00:01:00.000Z",
    });
    await command({
      type: "VoidShipmentLabel",
      postageProviderLabelId: labelA,
      refundStatus: input.mode === "immediate" ? "refunded" : "submitted",
      refundReference,
      voidedAt: "2030-01-01T00:02:00.000Z",
    });
    if (input.mode === "late-after-rebuy") {
      await command({
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: labelB,
        trackingIdentifier: `synthetic_tracking_B_${input.shipmentId}`,
        postageProviderName: "synthetic-postage",
        postageProviderMode: "test",
        postageProviderShipmentId: `synthetic_shipment_B_${input.shipmentId}`,
        postageProviderLabelId: labelB,
        postageAmountCents: input.amountCents + 100,
        postageCurrency: "USD",
        attachedAt: "2030-01-01T00:03:00.000Z",
      });
    }
    if (input.mode !== "immediate") {
      await command({
        type: "RecordShipmentLabelRefundStatus",
        postageProviderLabelId: labelA,
        refundStatus: input.mode === "rejected" ? "rejected" : "refunded",
        refundReference,
        resolvedAt: "2030-01-01T00:04:00.000Z",
      });
    }

    const eventStore = createPostgresEventStore({ pool: pools.fulfillment });
    const stored = await eventStore.readStream({ streamId });
    const publicRefunds = stored
      .filter((candidate) => candidate.eventType === "fulfillment.shipment.label-refund-status-recorded")
      .map(toTransportEvent);
    expect(publicRefunds).toEqual([
      expect.objectContaining({
        type: "fulfillment.shipment.label-refund-status-recorded",
        data: expect.objectContaining({
          shipmentId: input.shipmentId,
          postageProviderLabelId: labelA,
          refundStatus: input.mode === "rejected" ? "rejected" : "refunded",
          refundReference,
        }),
      }),
    ]);

    return { services, streamId, labelA, labelB, refundReference };
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

  it("retains validated activation from createServices through the registered equality-time handler", async () => {
    const activation = validateMarketplaceLabelPostageActivation({
      policyVersion: MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
      activatedAt: "2030-01-01T00:00:00.000Z",
    });
    await appendEvents(
      "fulfillment.shipment-shp_synthetic_composition",
      [
        created("shp_synthetic_composition"),
        labelAttached("shp_synthetic_composition", "pl_synthetic_composition", 825),
      ],
      [activation.activatedAt, activation.activatedAt],
    );
    const runtime = await createRuntime(activation);

    await drain(runtime.fulfillmentRunner, "postage-synthetic-composition");
    await projectWallet(runtime);

    expect(await postageRows()).toEqual([
      expect.objectContaining({
        shipment_id: "shp_synthetic_composition",
        postage_provider_label_id: "pl_synthetic_composition",
        outcome: "debit-posted",
      }),
    ]);
    expect(await ledgerRows()).toEqual([
      expect.objectContaining({
        kind: "platform-purchase",
        direction: "debit",
        amount: "8.25",
        order_id: "ord_shp_synthetic_composition",
      }),
    ]);
  });

  it("label-postage-debit-once: serializes concurrent runners, duplicate facts, and projection replay", async () => {
    await appendEvents("fulfillment.shipment-shp_once", [
      created("shp_once"),
      labelAttached("shp_once", "pl_once", 525),
      labelAttached("shp_once", "pl_once", 525),
    ]);
    const first = await createRuntime();
    const second = await createRuntime(await readMarketplaceLabelPostageActivation(pools.settlement));

    await Promise.all([
      first.fulfillmentRunner.runOnce(projectionRunContext("postage-concurrent-a")),
      second.fulfillmentRunner.runOnce(projectionRunContext("postage-concurrent-b")),
    ]);
    await drain(first.fulfillmentRunner, "postage-concurrent-finish");
    await projectWallet(first);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect(await postageRows()).toHaveLength(1);

    const activatedAt = (await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt;
    await first.fulfillmentRunner.reset(projectionRunContext("postage-reset"));
    await drain(first.fulfillmentRunner, "postage-reset-replay");
    await projectWallet(first);
    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect((await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt).toBe(activatedAt);

    await pools.settlement.query("TRUNCATE settlement_marketplace_label_postage");
    await first.fulfillmentRunner.reset(projectionRunContext("postage-rebuild"));
    await drain(first.fulfillmentRunner, "postage-replay");
    await projectWallet(first);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect(await postageRows()).toHaveLength(1);
    expect((await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt).toBe(activatedAt);

    const rebooted = await createRuntime(await readMarketplaceLabelPostageActivation(pools.settlement));
    await drain(rebooted.fulfillmentRunner, "postage-reboot-replay");
    await projectWallet(rebooted);
    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(1);
    expect((await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt).toBe(activatedAt);
  });

  it("label-postage-negative-offset: allows the debit and offsets it before release hold", async () => {
    const orderId = "ord_negative_offset";
    await appendEvents("fulfillment.shipment-shp_negative", [
      created("shp_negative", orderId),
      labelAttached("shp_negative", "pl_negative", 500),
    ]);
    const runtime = await createRuntime();
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

  it("label-postage-refund-credit: carries actual producer facts through the registered runner into Wallet", async () => {
    const runtime = await createRuntime();
    const immediate = await produceRefundSequence({ shipmentId: "shp_immediate", amountCents: 425, mode: "immediate" });
    const submitted = await produceRefundSequence({ shipmentId: "shp_submitted", amountCents: 525, mode: "submitted" });
    const late = await produceRefundSequence({ shipmentId: "shp_late", amountCents: 625, mode: "late-after-rebuy" });
    const rejected = await produceRefundSequence({ shipmentId: "shp_rejected", amountCents: 725, mode: "rejected" });

    await late.services.shipments.commandHandler({
      streamId: late.streamId,
      context: eventStoreContext(),
      command: {
        type: "RecordShipmentLabelRefundStatus",
        postageProviderLabelId: late.labelA,
        refundStatus: "refunded",
        refundReference: late.refundReference,
        resolvedAt: "2030-01-01T00:04:00.000Z",
      },
    });
    const lateStoredRefunds = (
      await createPostgresEventStore({ pool: pools.fulfillment }).readStream({ streamId: late.streamId })
    ).filter((candidate) => candidate.eventType === "fulfillment.shipment.label-refund-status-recorded");
    expect(lateStoredRefunds).toHaveLength(1);
    const concurrent = await createRuntime(await readMarketplaceLabelPostageActivation(pools.settlement));
    await Promise.all([
      runtime.fulfillmentRunner.runOnce(projectionRunContext("postage-refund-concurrent-a")),
      concurrent.fulfillmentRunner.runOnce(projectionRunContext("postage-refund-concurrent-b")),
    ]);
    await drain(runtime.fulfillmentRunner, "postage-refund");
    await projectWallet(runtime);

    const ledger = await ledgerRows();
    expect(ledger.filter((row) => row.direction === "debit")).toHaveLength(5);
    expect(ledger.filter((row) => row.direction === "credit")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: "4.25", order_id: "ord_shp_immediate" }),
        expect.objectContaining({ amount: "5.25", order_id: "ord_shp_submitted" }),
        expect.objectContaining({ amount: "6.25", order_id: "ord_shp_late" }),
      ]),
    );
    expect(ledger.filter((row) => row.direction === "credit")).toHaveLength(3);

    const rows = await postageRows();
    for (const original of [immediate, submitted, late]) {
      const row = rows.find((candidate) => candidate.postage_provider_label_id === original.labelA)!;
      expect(row.refund_reference).toBe(original.refundReference);
      expect(row.refund_status).toBe("refunded");
      expect(row.refund_ledger_entry_id).not.toBeNull();
      expect(row.refund_ledger_entry_id).not.toBe(row.debit_ledger_entry_id);
    }
    const replacement = rows.find((row) => row.postage_provider_label_id === late.labelB)!;
    expect(replacement.refund_status).toBeNull();
    expect(replacement.refund_ledger_entry_id).toBeNull();
    const rejectedRow = rows.find((row) => row.postage_provider_label_id === rejected.labelA)!;
    expect(rejectedRow.refund_status).toBe("rejected");
    expect(rejectedRow.refund_ledger_entry_id).toBeNull();

    const activatedAt = (await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt;
    await runtime.fulfillmentRunner.reset(projectionRunContext("postage-refund-reset"));
    await drain(runtime.fulfillmentRunner, "postage-refund-replay");
    await projectWallet(runtime);
    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(5);
    expect((await ledgerRows()).filter((row) => row.direction === "credit")).toHaveLength(3);

    await pools.settlement.query("TRUNCATE settlement_marketplace_label_postage, settlement_order_fulfillment_sources");
    await runtime.fulfillmentRunner.reset(projectionRunContext("postage-refund-rebuild"));
    await drain(runtime.fulfillmentRunner, "postage-refund-rebuild-replay");
    await projectWallet(runtime);
    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toHaveLength(5);
    expect((await ledgerRows()).filter((row) => row.direction === "credit")).toHaveLength(3);
    expect((await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt).toBe(activatedAt);
  });

  it("label-postage-skip-and-refuse: records typed outcomes and no money movement", async () => {
    await appendEvents("fulfillment.shipment-shp_null", [created("shp_null"), labelAttached("shp_null", null, null)]);
    await appendEvents("fulfillment.shipment-shp_currency", [
      created("shp_currency"),
      labelAttached("shp_currency", "pl_currency", 500, "cad"),
    ]);
    const runtime = await createRuntime();
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

  it("label-postage-cutover: uses the one DB activation after bootstrap and not the migration ledger", async () => {
    const absent = await pools.settlement.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM settlement_marketplace_label_postage_activation",
    );
    expect(absent.rows).toEqual([{ count: "0" }]);

    const migration = await pools.settlement.query<{ applied_at: string }>(
      `SELECT applied_at::text AS applied_at
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260910_settlement_marketplace_label_postage'`,
    );
    const historicalStored = await appendEvents(
      "fulfillment.shipment-shp_historical",
      [created("shp_historical"), labelAttached("shp_historical", "pl_historical", 400)],
      null,
    );

    const activation = await activateMarketplaceLabelPostage(pools.settlement);
    const historicalRecordedAt = new Date(Date.parse(activation.activatedAt) - 1).toISOString();
    await pools.fulfillment.query("UPDATE event_store_events SET recorded_at = $2 WHERE event_id = $1", [
      historicalStored[1]!.eventId,
      historicalRecordedAt,
    ]);
    const later = new Date(Date.parse(activation.activatedAt) + 1).toISOString();
    await appendEvents(
      "fulfillment.shipment-shp_boundary",
      [created("shp_boundary"), labelAttached("shp_boundary", "pl_boundary", 450)],
      [activation.activatedAt, activation.activatedAt],
    );
    await appendEvents(
      "fulfillment.shipment-shp_later",
      [created("shp_later"), labelAttached("shp_later", "pl_later", 550)],
      [later, later],
    );
    const runtime = await createRuntime(activation);
    await drain(runtime.fulfillmentRunner, "postage-cutover");
    await projectWallet(runtime);

    expect((await ledgerRows()).filter((row) => row.direction === "debit")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: "4.50", order_id: "ord_shp_boundary" }),
        expect.objectContaining({ amount: "5.50", order_id: "ord_shp_later" }),
      ]),
    );
    expect((await postageRows()).map((row) => [row.shipment_id, row.outcome])).toEqual([
      ["shp_boundary", "debit-posted"],
      ["shp_historical", "skipped-historical"],
      ["shp_later", "debit-posted"],
    ]);
    const migrationLedgerWouldChargeFailedRolloutFact =
      Date.parse(historicalRecordedAt) >= Date.parse(migration.rows[0]!.applied_at);
    expect(migrationLedgerWouldChargeFailedRolloutFact).toBe(true);
    expect(Date.parse(historicalRecordedAt)).toBeLessThan(Date.parse(activation.activatedAt));
    expect((await readMarketplaceLabelPostageActivation(pools.settlement)).activatedAt).toBe(activation.activatedAt);
  });

  it("label-postage-cutover: racing workers converge and missing or malformed provenance fails closed", async () => {
    await expect(readMarketplaceLabelPostageActivation(pools.settlement)).rejects.toThrow(
      "activation provenance is missing",
    );

    const [first, second] = await Promise.all([
      activateMarketplaceLabelPostage(pools.settlement),
      activateMarketplaceLabelPostage(pools.settlement),
    ]);
    expect(second).toEqual(first);
    const rows = await pools.settlement.query<{ policy_version: string; activated_at: string }>(
      "SELECT policy_version, activated_at::text AS activated_at FROM settlement_marketplace_label_postage_activation",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.policy_version).toBe(MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION);

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
    await pools.settlement.query(
      `INSERT INTO settlement_marketplace_label_postage_activation (singleton, policy_version, activated_at)
       VALUES (true, 'synthetic-malformed-policy-version', clock_timestamp())`,
    );
    await expect(readMarketplaceLabelPostageActivation(pools.settlement)).rejects.toThrow(
      "activation policy version is invalid",
    );
  });

  it("label-postage-statement: renders the shipment reference through the existing statement query", async () => {
    await appendEvents("fulfillment.shipment-shp_statement", [
      created("shp_statement"),
      labelAttached("shp_statement", "pl_statement", 575),
    ]);
    const runtime = await createRuntime();
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

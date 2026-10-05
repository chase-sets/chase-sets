import { expect, it, vi } from "vitest";
import { drainContextRuntime, drainSubscriptionRunners } from "@chase-sets/bounded-context-runtime";
import { seedMountedContextTestRuntimeIfEmpty } from "@chase-sets/bounded-context-runtime/test-support";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import {
  createMarketplaceSeedRuntime,
  describeWithMarketplaceSeedDatabase,
  marketplaceSeedLifecycleContextOrder,
  useMarketplaceSeedRuntime,
} from "../index";

const subscriptions = [
  { source: "ordering", key: "payments-order-input-projection:ordering:v3", types: ["ordering.order.created"] },
  {
    source: "ordering",
    key: "payments-order-cancellation-refund-effect:ordering:v1",
    types: ["ordering.order.cancelled"],
  },
  {
    source: "payments",
    key: "payments-order-cancellation-refund-effect:payments:v1",
    types: ["payments.payment-captured"],
  },
  {
    source: "platform-operations",
    key: "payments-support-refund-effect:platform-operations:v1",
    types: ["support.support-request.resolved"],
  },
  {
    source: "fulfillment",
    key: "payments-support-refund-effect:fulfillment:v1",
    types: ["fulfillment.return-shipment.label-ready.v1"],
  },
] as const;

describeWithMarketplaceSeedDatabase("payments real money feed coverage", () => {
  const seed = useMarketplaceSeedRuntime("payments-money-feed-coverage");

  it("payments money subscriptions stay error-free on every real seed and reconciliation feed", async () => {
    const { pools } = seed;
    const runtime = createMarketplaceSeedRuntime(pools);
    const runners = runtime.subscriptionRunners.filter((runner) =>
      subscriptions.some(({ key }) => key === runner.checkpointKey),
    );
    expect(runners.map((runner) => runner.checkpointKey).sort()).toEqual(subscriptions.map(({ key }) => key).sort());

    const sourceHead = async (source: (typeof subscriptions)[number]["source"]) =>
      (
        await pools[source].query<{ position: string }>(
          "SELECT COALESCE(MAX(global_position), 0)::text AS position FROM event_store_events",
        )
      ).rows[0]!.position;

    const proveFeed = async (feed: string, source: (typeof subscriptions)[number]["source"], before: string) => {
      await drainContextRuntime(runtime);
      for (const subscription of subscriptions.filter((candidate) => candidate.source === source)) {
        const events = await pools[source].query<{ event_id: string; global_position: string }>(
          `SELECT event_id, global_position::text AS global_position FROM event_store_events
           WHERE global_position > $1::bigint AND event_type = ANY($2::text[]) ORDER BY global_position`,
          [before, subscription.types],
        );
        expect(events.rows.length, `${feed} must produce events for ${subscription.key}`).toBeGreaterThan(0);
        const runner = runners.find((candidate) => candidate.checkpointKey === subscription.key)!;
        const status = await runner.refreshStatus();
        expect(status.state, `${feed}: ${subscription.key}`).toBe("caught-up");
        expect(BigInt(status.lastGlobalPosition)).toBeGreaterThanOrEqual(BigInt(events.rows.at(-1)!.global_position));
        for (const table of ["event_projection_poison_events", "event_projection_blocked_streams"]) {
          expect(
            (await pools.payments.query(`SELECT * FROM ${table} WHERE projection_key = $1`, [subscription.key])).rows,
            `${feed}: ${subscription.key}: ${table}`,
          ).toEqual([]);
        }
      }
    };

    for (const contextName of marketplaceSeedLifecycleContextOrder) {
      const feedSource =
        contextName === "ordering" || contextName === "payments" || contextName === "platform-operations"
          ? contextName
          : null;
      const before = feedSource ? await sourceHead(feedSource) : null;
      await seedMountedContextTestRuntimeIfEmpty(runtime, [contextName]);
      if (feedSource) await proveFeed(`seed:${contextName}`, feedSource, before!);
    }

    const stale = (
      await pools.payments.query<{
        payment_id: string;
        processor_payment_reference: string;
        processor_payment_kind: "payment-intent";
      }>(
        `SELECT payment_id, processor_payment_reference, processor_payment_kind FROM payments_payment_pages
       WHERE status = 'pending-confirmation' ORDER BY payment_id LIMIT 1`,
      )
    ).rows[0];
    expect(stale).toBeDefined();
    await pools.payments.query(
      "UPDATE payments_payment_pages SET updated_at = NOW() - INTERVAL '1 hour' WHERE payment_id = $1",
      [stale!.payment_id],
    );
    const processorGateway = createFakePaymentProcessorGateway({
      paymentResults: {
        [stale!.processor_payment_reference]: {
          processorName: "stripe",
          processorPaymentKind: stale!.processor_payment_kind,
          processorPaymentReference: stale!.processor_payment_reference,
          internalPaymentId: stale!.payment_id as never,
          processorStatus: "succeeded",
          outcome: "captured",
          occurredAt: "2026-10-04T12:00:00.000Z",
        },
      },
    });
    const retrieve = vi.spyOn(processorGateway, "retrievePaymentResult");
    const payments = paymentsModule.createServices(pools.payments, { processorGateway });
    const beforeScan = await sourceHead("payments");
    const scan = await payments.payments.scanPaymentsNeedingReconciliation({ limit: 100 });
    expect(scan.payment_ids).toContain(stale!.payment_id);
    expect(scan.repaired).toBeGreaterThan(0);
    expect(retrieve).toHaveBeenCalledWith(stale!.processor_payment_reference);
    await proveFeed("scanPaymentsNeedingReconciliation", "payments", beforeScan);
    expect(
      (
        await pools.payments.query("SELECT status FROM payments_payment_pages WHERE payment_id = $1", [
          stale!.payment_id,
        ])
      ).rows,
    ).toEqual([{ status: "captured" }]);

    type FulfillmentPorts = NonNullable<Parameters<typeof fulfillmentModule.createServices>[1]>;
    type PostageProvider = NonNullable<FulfillmentPorts["postageLabelProvider"]>;
    const returnShipmentId = "rsh_synthetic_money_reconciliation";
    const operationKey = `return-shipment:${returnShipmentId}:purchase-label`;
    const recover = vi.fn<NonNullable<PostageProvider["recoverPurchasedUspsLabel"]>>(async () => ({
      providerName: "synthetic-money-postage",
      providerMode: "test",
      providerShipmentId: "ps_synthetic_money",
      providerLabelId: "pl_synthetic_money",
      providerRateId: null,
      serviceLevel: "usps-ground-advantage",
      trackingIdentifier: "tracking_synthetic_money",
      carrierName: "usps",
      labelReference: "label_synthetic_money",
      labelDocumentUrl: "https://labels.test/synthetic-money.pdf",
      postageAmountCents: 1299,
      postageCurrency: "USD",
      purchasedAt: "2026-10-04T12:00:00.000Z",
    }));
    const provider: PostageProvider = {
      providerName: "synthetic-money-postage",
      providerMode: "test",
      recoverPurchasedUspsLabel: recover,
      purchaseUspsLabel: async () => {
        throw new Error("Recovery must not purchase a new label.");
      },
      voidLabel: async () => {
        throw new Error("Recovery must not void a label.");
      },
    };
    const fulfillment = fulfillmentModule.createServices(pools.fulfillment, { postageLabelProvider: provider });
    const address = {
      name: "Synthetic Buyer",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const context = {
      tenantId: "tnt_synthetic_money" as never,
      audit: { performedByUserId: "usr_synthetic_money" as never, forAccountId: "acc_synthetic_money" as never },
    };
    await fulfillment.returnShipments.commandHandler({
      streamId: fulfillment.returnShipments.streamIdFor(returnShipmentId),
      expectedVersion: 0,
      context,
      command: {
        type: "RequestReturnShipment",
        returnShipmentId: returnShipmentId as never,
        remedyId: "rmd_synthetic_money" as never,
        supportRequestId: "sup_synthetic_money" as never,
        orderId: "ord_synthetic_money" as never,
        outboundShipmentId: "shp_synthetic_money" as never,
        affectedOrderLineIds: ["oli_synthetic_money"],
        returnDirective: "return-to-platform",
        shipFromSnapshot: address,
        destinationSnapshot: {
          destinationType: "platform-facility",
          facilityId: "fac_synthetic_money",
          configVersion: "synthetic-v1",
          displayName: "Synthetic Facility",
          displayInstructions: "Synthetic fixture",
          postalAddress: address,
          region: "us-east",
          selectionPolicyVersion: "synthetic-v1",
          selectedAt: "2026-10-04T12:00:00.000Z",
        },
        packageRequirements: { weightOunces: 10, lengthInches: 9, widthInches: 6, heightInches: 2 },
        costPayer: "platform",
        costAllocationReference: "cov_synthetic_money",
        shipByDeadlineAt: "2026-10-10T12:00:00.000Z",
        returnByDeadlineAt: "2026-10-20T12:00:00.000Z",
        metadata: {
          correlationRemedyId: "rmd_synthetic_money" as never,
          causationId: null,
          idempotencyKey: operationKey,
          policyVersion: "synthetic-v1",
        },
        requestedAt: "2026-10-04T12:00:00.000Z",
      },
    });
    await drainSubscriptionRunners(runners);
    expect(
      (
        await pools.payments.query(
          "SELECT label_status FROM payments_return_label_sources WHERE return_shipment_id = $1",
          [returnShipmentId],
        )
      ).rows,
    ).toHaveLength(1);
    await pools.fulfillment.query(
      `INSERT INTO fulfillment_return_shipment_label_operations
       (operation_key, operation_kind, return_shipment_id, remedy_id, provider_name, provider_mode, idempotency_key, status, created_at, updated_at)
       VALUES ($1, 'purchase-label', $2, 'rmd_synthetic_money', 'synthetic-money-postage', 'test', $1, 'pending', $3, $3)`,
      [operationKey, returnShipmentId, "2026-10-04T10:00:00.000Z"],
    );
    const beforeRecovery = await sourceHead("fulfillment");
    expect(
      await fulfillment.returnShipments.labelPurchase.reconcileStaleReturnLabelPurchases(
        { staleBefore: "2026-10-04T11:00:00.000Z" },
        context,
      ),
    ).toEqual({ checked: 1, attached: 1, failed: 0 });
    expect(recover).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: operationKey });
    await proveFeed("reconcileStaleReturnLabelPurchases", "fulfillment", beforeRecovery);
    expect(
      (
        await pools.payments.query(
          "SELECT postage_amount::text AS amount, label_status, currency_code FROM payments_return_label_sources WHERE return_shipment_id = $1",
          [returnShipmentId],
        )
      ).rows,
    ).toEqual([{ amount: "12.99", label_status: "ready", currency_code: "USD" }]);
    expect(
      (
        await pools.fulfillment.query(
          "SELECT status FROM fulfillment_return_shipment_label_operations WHERE operation_key = $1",
          [operationKey],
        )
      ).rows,
    ).toEqual([{ status: "succeeded" }]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase, drainSubscriptionRunners } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { module as paymentsModule } from "../index";
import { buildPaymentsOrderInputProjectionHandlers } from "../features/payments/integrations/order-input/order-input-projection";
import { buildPaymentProjectionHandlers } from "../features/payments/read-model/projection";

const databaseUrl = process.env.TEST_DATABASE_URL;
const contextNames = ["payments", "ordering", "fulfillment", "platform-operations", "identity"] as const;
const keys = [
  "payments-order-input-projection:ordering:v3",
  "payments-support-refund-effect:platform-operations:v1",
  "payments-support-refund-effect:fulfillment:v1",
  "payments-order-cancellation-refund-effect:ordering:v1",
  "payments-order-cancellation-refund-effect:payments:v1",
] as const;
const now = "2026-10-04T12:00:00.000Z";
const context: EventStoreContext = {
  tenantId: "tnt_synthetic_money" as never,
  audit: { performedByUserId: "usr_synthetic_money" as never, forAccountId: "acc_synthetic_money" as never },
};

function sourceModule(contextName: string) {
  return {
    contextName,
    routePrefix: `/api/${contextName}`,
    streamPrefix: `${contextName}.`,
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({}),
    buildApis: () => [],
  } satisfies BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>>;
}

function orderData(orderId: string, net = "1.00"): JsonObject {
  return {
    orderId,
    sourceType: "cart-checkout",
    sourceReferenceId: null,
    buyerAccountId: "acc_synthetic_money",
    sellerAccountId: "acc_synthetic_seller",
    totalAmount: "1.00",
    commercialTermsSnapshot: {
      marketplaceSalesFeeAmount: "0.00",
      sellerNetAmount: net,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: now,
    },
  };
}

describe("payments money subscription DB proof (synthetic isolated fixtures)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  const issueRefund = vi.fn(async (input: { amount: string; refundId: string }) => ({
    outcome: "requested",
    refundId: input.refundId,
    version: 1,
    amount: input.amount,
  }));
  let noApplyStream: string | undefined;
  let restoreSkippedEffect: (() => Promise<unknown>) | undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; skipped tests are not subscription proof.");
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, contextNames, "payments_money_consolidation");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    issueRefund.mockClear();
    noApplyStream = undefined;
    restoreSkippedEffect = undefined;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    for (const name of contextNames.filter((name) => name !== "payments")) {
      await bootstrapContextDatabase(sourceModule(name), pools[name]);
    }
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function mount() {
    const module = {
      ...paymentsModule,
      buildSubscriptions: (services: ReturnType<typeof paymentsModule.createServices>) =>
        paymentsModule.buildSubscriptions!(services).map((subscription) => ({
          ...subscription,
          handlers: Object.fromEntries(
            Object.entries(subscription.handlers).map(([type, handler]) => [
              type,
              async (event: Parameters<NonNullable<typeof handler>>[0]) => {
                if (event.streamId === noApplyStream) {
                  restoreSkippedEffect = () => handler!(event);
                  return;
                }
                return handler!(event);
              },
            ]),
          ),
        })),
      createServices: (pool: PgTransactionalPool) => {
        const services = paymentsModule.createServices(pool, { processorGateway: createFakePaymentProcessorGateway() });
        return { ...services, refunds: { ...services.refunds, issueRefund: issueRefund as never } };
      },
    };
    return createMountedContextTestRuntime([
      { contextName: "payments", module, pool: pools.payments, ports: {} },
      ...contextNames
        .filter((name) => name !== "payments")
        .map((name) => ({
          contextName: name,
          mountRole: "source-only" as const,
          module: sourceModule(name),
          pool: pools[name],
          ports: {},
        })),
    ]);
  }

  async function append(
    source: (typeof contextNames)[number],
    streamId: string,
    eventType: string,
    payload: JsonObject,
  ) {
    const store = createPostgresEventStore({ pool: pools[source] });
    return (
      await store.appendToStream({
        streamId,
        expectedVersion: "any",
        context,
        events: [{ eventType, payload }],
      })
    )[0]!;
  }

  async function prepareOrder(orderId: string, cancelled = false) {
    await buildPaymentsOrderInputProjectionHandlers(pools.payments)["ordering.order.created"]!({
      data: orderData(orderId),
      timing: { recordedAt: now },
    } as never);
    if (cancelled)
      await pools.payments.query("UPDATE payments_order_inputs SET status = 'cancelled' WHERE order_id = $1", [
        orderId,
      ]);
    const handlers = buildPaymentProjectionHandlers(pools.payments);
    await handlers["payments.payment-created"]!({
      streamVersion: 1,
      data: {
        paymentId: `pay_synthetic_${orderId}`,
        buyerAccountId: "acc_synthetic_money",
        orderIds: [orderId],
        orderRefundCaps: [{ orderId, amount: "1.00" }],
        amount: "1.00",
        balanceCreditAmount: "0.00",
        processorAmount: "1.00",
        marketplaceSalesFeeAmount: "0.00",
        marketplaceCheckoutFeeAmount: "0.00",
        sellerNetAmount: "1.00",
        sellerPayoutAmount: "1.00",
        sellerPayouts: [],
        currencyCode: "USD",
        processorName: "synthetic",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: `pi_synthetic_${orderId}`,
        processorClientSecret: null,
        processorStatus: "succeeded",
        sourceContext: null,
        sourceReferenceId: null,
        createdAt: now,
      },
    } as never);
    await handlers["payments.payment-captured"]!({
      streamVersion: 2,
      data: { paymentId: `pay_synthetic_${orderId}`, processorStatus: "succeeded", capturedAt: now },
    } as never);
  }

  async function errors(key: string) {
    const poison = await pools.payments.query(
      "SELECT event_id, state, retry_count, resolved_at FROM event_projection_poison_events WHERE projection_key = $1 ORDER BY event_id",
      [key],
    );
    const blocked = await pools.payments.query(
      "SELECT stream_id, state, deferred_event_count FROM event_projection_blocked_streams WHERE projection_key = $1 ORDER BY stream_id",
      [key],
    );
    return { poison: poison.rows, blocked: blocked.rows };
  }

  it.each(keys)(
    "payments projections drain, checkpoint, poison, recover and replay across all five subscriptions: %s",
    async (key) => {
      const index = keys.indexOf(key);
      const source = ["ordering", "platform-operations", "fulfillment", "ordering", "payments"][
        index
      ] as (typeof contextNames)[number];
      const eventType = [
        "ordering.order.created",
        "support.support-request.resolved",
        "fulfillment.return-shipment.label-ready.v1",
        "ordering.order.cancelled",
        "payments.payment-captured",
      ][index]!;
      const prefix = [
        "ordering.order-",
        "support.support-request-",
        "fulfillment.return-shipment-",
        "ordering.order-",
        "payments.payment-",
      ][index]!;
      const badOrder = `ord_synthetic_bad_${index}`;
      const goodOrder = `ord_synthetic_good_${index}`;
      const unrelatedOrder = `ord_synthetic_unrelated_${index}`;
      const controlOrder = `ord_synthetic_no_apply_${index}`;
      await prepareOrder(badOrder, index === 4);
      await prepareOrder(goodOrder, index === 4);
      if (index !== 0) await prepareOrder(unrelatedOrder, index === 4);
      if (index !== 0) await prepareOrder(controlOrder, index === 4);
      if (index === 2) {
        for (const orderId of [badOrder, goodOrder, unrelatedOrder, controlOrder]) {
          await pools.payments.query(
            `INSERT INTO payments_return_label_sources
             (return_shipment_id, support_request_id, cost_payer, updated_at)
             VALUES ($1, $2, 'platform', $3)`,
            [`rsh_synthetic_${orderId}`, `sup_synthetic_${orderId}`, now],
          );
        }
      }
      const payloadFor = (orderId: string, corrupt: boolean): JsonObject => {
        if (index === 0) return orderData(orderId, corrupt ? "1.001" : "1.00");
        if (index === 1)
          return {
            supportRequestId: `sup_synthetic_${orderId}`,
            orderId,
            resolution: { resolutionType: "partial-refund", refundAmount: corrupt ? "1.001" : "1.00", resolvedAt: now },
          };
        if (index === 2)
          return {
            returnShipmentId: `rsh_synthetic_${orderId}`,
            postageAmountCents: corrupt ? -1 : 1299,
            postageCurrency: "USD",
            readyAt: now,
          };
        if (index === 3) return { orderId, reason: "seller-cannot-fulfill", cancelledAt: now };
        return {
          paymentId: `pay_synthetic_${orderId}`,
          orderIds: [orderId],
          marketplaceCheckoutFeeAmount: corrupt ? "1.001" : "0.00",
          capturedAt: now,
        };
      };
      const runtime = mount();
      const runners = runtime.subscriptionRunners.filter((runner) => keys.includes(runner.checkpointKey as never));
      expect(runners.map((runner) => runner.checkpointKey).sort()).toEqual([...keys].sort());
      const runner = runners.find((runner) => runner.checkpointKey === key)!;
      expect((await runner.retryBlockedStream(`${prefix}synthetic_absent`)).state).toBe("already-resolved");

      await append(source, `${prefix}synthetic_initial`, eventType, payloadFor(goodOrder, false));
      await drainSubscriptionRunners(runners);
      for (const candidate of runners) {
        expect((await candidate.refreshStatus()).state).toBe("caught-up");
        expect(await errors(candidate.checkpointKey)).toEqual({ poison: [], blocked: [] });
      }
      const steadyCheckpoint = (await runner.refreshStatus()).lastGlobalPosition;
      await drainSubscriptionRunners(runners);
      expect((await runner.refreshStatus()).lastGlobalPosition).toBe(steadyCheckpoint);
      await runner.reset();
      expect((await runner.refreshStatus()).lastGlobalPosition).toBe("0");
      await drainSubscriptionRunners(runners);
      expect((await runner.refreshStatus()).lastGlobalPosition).toBe(steadyCheckpoint);
      for (const candidate of runners) {
        expect((await candidate.refreshStatus()).state).toBe("caught-up");
        expect(await errors(candidate.checkpointKey)).toEqual({ poison: [], blocked: [] });
      }

      // Only this disposable synthetic fixture is corrupt. Ordering cancellation
      // carries no monetary field, so its arithmetic reads the captured JSONB cap.
      if (index === 3)
        await pools.payments.query(
          "UPDATE payments_payment_pages SET order_refund_caps = $2::jsonb WHERE payment_id = $1",
          [`pay_synthetic_${badOrder}`, JSON.stringify([{ orderId: badOrder, amount: "1.001" }])],
        );
      const badStream = `${prefix}synthetic_bad`;
      const poisoned = await append(source, badStream, eventType, payloadFor(badOrder, true));
      await drainSubscriptionRunners(runners);
      let receipt = await errors(key);
      expect(receipt.poison).toEqual([
        expect.objectContaining({ event_id: poisoned.eventId, state: "blocked", retry_count: 0, resolved_at: null }),
      ]);
      expect(receipt.blocked).toEqual([
        expect.objectContaining({ stream_id: badStream, state: "blocked", deferred_event_count: 0 }),
      ]);
      expect(BigInt((await runner.refreshStatus()).lastGlobalPosition)).toBeGreaterThanOrEqual(
        BigInt(poisoned.globalPosition),
      );

      const later = await append(source, badStream, eventType, payloadFor(badOrder, false));
      await append(source, `${prefix}synthetic_unrelated`, eventType, payloadFor(goodOrder, false));
      const readUnrelatedEffect = async (orderId = unrelatedOrder) => {
        if (index === 0)
          return (
            await pools.payments.query(
              "SELECT seller_net_amount::text AS amount FROM payments_order_inputs WHERE order_id = $1",
              [orderId],
            )
          ).rows;
        if (index === 2)
          return (
            await pools.payments.query(
              "SELECT postage_amount::text AS amount, label_status AS status FROM payments_return_label_sources WHERE return_shipment_id = $1",
              [`rsh_synthetic_${orderId}`],
            )
          ).rows;
        const table = index === 1 ? "payments_support_refund_effects" : "payments_order_cancellation_refund_effects";
        return (
          await pools.payments.query(
            `SELECT requested_amount::text AS amount, status FROM ${table} WHERE order_id = $1`,
            [orderId],
          )
        ).rows;
      };
      const beforeUnrelated = await readUnrelatedEffect();
      if (index === 2) expect(beforeUnrelated).toEqual([{ amount: "0.00", status: "requested" }]);
      else expect(beforeUnrelated).toEqual([]);
      await append(source, `${prefix}synthetic_distinct_unrelated`, eventType, payloadFor(unrelatedOrder, false));
      if (index === 0) {
        await append("ordering", "ordering.order-synthetic_cancellation_sibling", "ordering.order.cancelled", {
          orderId: goodOrder,
          reason: "seller-cannot-fulfill",
          cancelledAt: now,
        });
      }
      await drainSubscriptionRunners(runners);
      const expectedUnrelated =
        index === 0
          ? [{ amount: "1.00" }]
          : index === 2
            ? [{ amount: "12.99", status: "ready" }]
            : [{ amount: "1.00", status: "refund-requested" }];
      expect(await readUnrelatedEffect()).toEqual(expectedUnrelated);
      expect(await readUnrelatedEffect()).not.toEqual(beforeUnrelated);
      if (index === 1 || index === 3 || index === 4)
        expect(issueRefund).toHaveBeenCalledWith(
          expect.objectContaining({ orderIds: [unrelatedOrder], amount: "1.00" }),
          expect.anything(),
        );
      const errorsBeforeControl = await errors(key);
      noApplyStream = `${prefix}synthetic_no_apply`;
      await append(source, noApplyStream, eventType, payloadFor(controlOrder, false));
      await drainSubscriptionRunners(runners);
      expect(restoreSkippedEffect).toBeDefined();
      const noApplyRows = await readUnrelatedEffect(controlOrder);
      expect(() => expect(noApplyRows).toEqual(expectedUnrelated)).toThrow();
      const checkpointWithFault = (await runner.refreshStatus()).lastGlobalPosition;
      expect(await errors(key)).toEqual(errorsBeforeControl);
      noApplyStream = undefined;
      await restoreSkippedEffect!();
      expect(await readUnrelatedEffect(controlOrder)).toEqual(expectedUnrelated);
      expect((await runner.refreshStatus()).lastGlobalPosition).toBe(checkpointWithFault);
      expect(await errors(key)).toEqual(errorsBeforeControl);
      receipt = await errors(key);
      expect(receipt.poison).toHaveLength(1);
      expect(receipt.blocked).toEqual([
        expect.objectContaining({ stream_id: badStream, state: "blocked", deferred_event_count: 1 }),
      ]);
      const degraded = await runner.refreshStatus();
      expect(degraded.state).toBe("degraded");
      expect(BigInt(degraded.lastGlobalPosition)).toBeGreaterThanOrEqual(BigInt(later.globalPosition));
      expect(degraded.lastGlobalPosition).toBe(degraded.sourceHeadGlobalPosition);
      for (const other of runners.filter((candidate) => candidate !== runner)) {
        expect(await errors(other.checkpointKey)).toEqual({ poison: [], blocked: [] });
        expect((await other.refreshStatus()).state).toBe("caught-up");
      }
      expect((await runner.retryBlockedStream(badStream)).state).toBe("still-blocked");
      expect((await errors(key)).poison[0]).toMatchObject({ retry_count: 1 });

      // Simulate correction of the synthetic corrupt source, not a production
      // event mutation or a change to the runner's recovery contract.
      if (index === 3)
        await pools.payments.query(
          "UPDATE payments_payment_pages SET order_refund_caps = $2::jsonb WHERE payment_id = $1",
          [`pay_synthetic_${badOrder}`, JSON.stringify([{ orderId: badOrder, amount: "1.00" }])],
        );
      else
        await pools[source].query("UPDATE event_store_events SET payload = $2::jsonb WHERE event_id = $1", [
          poisoned.eventId,
          JSON.stringify(payloadFor(badOrder, false)),
        ]);
      expect((await runner.retryBlockedStream(badStream)).state).toBe("resolved");
      receipt = await errors(key);
      expect(receipt.poison).toEqual([
        expect.objectContaining({
          event_id: poisoned.eventId,
          state: "resolved",
          retry_count: 2,
          resolved_at: expect.anything(),
        }),
      ]);
      expect(receipt.blocked).toEqual([expect.objectContaining({ stream_id: badStream, state: "resolved" })]);
      expect((await runner.refreshStatus()).state).toBe("caught-up");
      const checkpoint = (await runner.refreshStatus()).lastGlobalPosition;
      const retained = mount().subscriptionRunners.filter((candidate) =>
        keys.includes(candidate.checkpointKey as never),
      );
      await drainSubscriptionRunners(retained);
      const replay = retained.find((candidate) => candidate.checkpointKey === key)!;
      expect((await replay.refreshStatus()).lastGlobalPosition).toBe(checkpoint);
      expect((await replay.refreshStatus()).state).toBe("caught-up");
      expect(await errors(key)).toEqual(receipt);
      await replay.reset();
      expect((await replay.refreshStatus()).lastGlobalPosition).toBe("0");
      await drainSubscriptionRunners(retained);
      expect((await replay.refreshStatus()).lastGlobalPosition).toBe(checkpoint);
      expect((await replay.refreshStatus()).state).toBe("caught-up");
      expect(await errors(key)).toEqual(receipt);
    },
  );
});

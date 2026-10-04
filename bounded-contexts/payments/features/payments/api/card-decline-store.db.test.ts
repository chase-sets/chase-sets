import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryFunction,
} from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PaymentProcessorGateway, PaymentProcessorWebhookEvent } from "@chase-sets/payment-processing";
import type { ProviderWebhookTelemetryEvent } from "@chase-sets/http/provider-errors";
import { module as paymentsModule } from "../../../index";
import { buildPaymentProjectionHandlers } from "../read-model/projection";
import { evolvePayment, initialPaymentState } from "../domain/domain";
import { createCardDeclineStore } from "./card-decline-store";
import { createPaymentRuntime } from "./runtime";
import { createPaymentWebhookRunner } from "./webhook-transaction";

const at = "2026-10-04T00:00:00.000Z";
const context = {
  tenantId: "tnt_decline" as never,
  audit: { performedByUserId: "usr_decline" as never, forAccountId: "acc_decline" as never },
};
const streamId = "payments.payment-pay_decline";
function decline(eventId: string, fingerprint = "synthetic_fingerprint"): PaymentProcessorWebhookEvent {
  return {
    eventId,
    kind: "payment-failed",
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference: "pi_decline",
    internalPaymentId: "pay_decline" as never,
    processorStatus: "requires_payment_method",
    failureCode: "card_declined",
    failureMessage: "Synthetic decline",
    occurredAt: at,
    savedPaymentMethod: {
      processorName: "stripe",
      providerCustomerReference: "cus_decline",
      providerReference: "pm_decline",
      paymentMethodCategory: "card",
      paymentMethodFingerprint: fingerprint,
      displayLabel: "Synthetic card",
      readiness: "ready",
      allowRedisplay: "always",
      removed: false,
    },
  };
}

describe("durable card decline velocity (real Postgres)", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let now: number;
  let signals: ProviderWebhookTelemetryEvent[];
  let orderSequence: number;
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected provider operation.");
  };
  const store = (database = pool, rule = { max: 5, windowMs: 1000 }) =>
    createCardDeclineStore(database, { now: () => now, rule });
  function runtime(database = pool) {
    const gateway = {
      getPublicConfiguration: () => ({
        processorName: "stripe",
        publishableKey: null,
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      }),
      createCustomer: unused,
      createSetupSession: unused,
      retrieveSetupSessionResult: unused,
      cancelSetupSession: unused,
      retrieveSavedPaymentMethod: unused,
      detachSavedPaymentMethod: unused,
      cancelPayment: unused,
      retrievePaymentResult: unused,
      createRefund: unused,
      submitDisputeEvidence: unused,
      createPaymentSession: vi.fn<PaymentProcessorGateway["createPaymentSession"]>(async (input) => ({
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: `pi_${input.paymentId}`,
        processorClientSecret: null,
        processorRedirectUrl: null,
        processorStatus: "requires_payment_method",
      })),
      parseWebhook: vi.fn<PaymentProcessorGateway["parseWebhook"]>(),
    } satisfies PaymentProcessorGateway;
    const eventStore = createPostgresEventStore({ pool: database });
    const payments = createPaymentRuntime({
      db: database,
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: database }),
      cardDeclineStore: store(database),
      runWebhookTransaction: createPaymentWebhookRunner(database, eventStore),
      processorGateway: gateway,
      webhookTelemetry: {
        record: (signal) => {
          signals.push(signal);
        },
      },
    });
    return {
      payments,
      gateway,
      deliver: (event: PaymentProcessorWebhookEvent) => {
        gateway.parseWebhook.mockResolvedValueOnce(event);
        return payments.processWebhook(
          { rawBody: "synthetic private payload", signatureHeader: "synthetic private signature" },
          context,
        );
      },
    };
  }
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required for card decline DB proof.");
    const urls = createMultiContextTestDatabaseUrls(url, ["payments"], "card_decline_velocity");
    await ensureMultiContextTestDatabases(url, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.payments;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pool);
    now = Date.parse(at);
    signals = [];
    orderSequence = 0;
    await runtime().payments.commandHandler({
      streamId,
      context,
      command: {
        type: "CreatePayment",
        paymentId: "pay_decline" as never,
        buyerAccountId: "acc_decline" as never,
        orderIds: ["ord_declined" as never],
        amount: "10.00",
        marketplaceSalesFeeAmount: "1.00",
        marketplaceCheckoutFeeAmount: "0.50",
        sellerNetAmount: "8.50",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: "pi_decline",
        processorClientSecret: null,
        processorStatus: "requires_payment_method",
        createdAt: at,
      },
    });
    const handlers = buildPaymentProjectionHandlers(pool);
    for (const event of await createPostgresEventStore({ pool }).readStream({ streamId }))
      await handlers[event.eventType]?.(toTransportEvent(event));
    await pool.query(`INSERT INTO payments_saved_checkout_instruments
      (instrument_id, account_id, payment_method_category, provider, provider_customer_reference, provider_reference, provider_fingerprint, display_label, confirmation_experience, readiness)
      VALUES ('sci_decline', 'acc_decline', 'card', 'stripe', 'cus_decline', 'pm_decline', 'synthetic_fingerprint', 'Synthetic card', 'off-session-token', 'ready')`);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function admit(replica: ReturnType<typeof runtime>, recover = false) {
    const orderId = `ord_admission_${++orderSequence}`;
    await pool.query(
      `INSERT INTO payments_order_inputs
      (order_id, buyer_account_id, total_amount, marketplace_sales_fee_amount, marketplace_checkout_fee_amount, seller_net_amount, terms_resolved_at, status, created_at, updated_at)
      VALUES ($1, 'acc_decline', 10, 1, 0.5, 8.5, $2, 'pending-payment', $2, $2)`,
      [orderId, at],
    );
    const params = {
      accountId: "acc_decline" as never,
      orderIds: [orderId as never],
      paymentMethodCategory: "card",
      savedCheckoutInstrumentId: "sci_decline",
    };
    const status = await replica.payments.getCheckoutStatus(params);
    return replica.payments[recover ? "recoverCheckoutPayment" : "createAccountPayment"](
      { ...params, marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint },
      context,
    );
  }
  async function state() {
    const result = await pool.query<{ count: number; reset_at: Date; fingerprint_digest: string }>(
      `SELECT decline_count AS count, reset_at, fingerprint_digest FROM payments_card_decline_counters ORDER BY fingerprint_digest`,
    );
    const receipts = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM payments_card_decline_events",
    );
    const inbox = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM payments_provider_webhook_events",
    );
    const history = await createPostgresEventStore({ pool }).readStream({ streamId });
    const payment = history.reduce(
      (current, event) =>
        evolvePayment(current, { type: event.eventType, data: event.payload } as Parameters<typeof evolvePayment>[1]),
      initialPaymentState,
    );
    return {
      counters: result.rows,
      receipts: receipts.rows[0]!.count,
      inbox: inbox.rows[0]!.count,
      payment: payment.status,
    };
  }
  function fault(matcher: (sql: string) => boolean): PgTransactionalPool {
    return {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: ((sql: string, values?: readonly unknown[]) => {
            if (matcher(sql)) throw new Error("synthetic private database detail");
            return client.query(sql, values);
          }) as PgQueryFunction,
        };
      },
    };
  }

  it("alternates independent runtimes, survives restart, and expires at the first-decline boundary", async () => {
    const replicas = [runtime(), runtime()];
    for (let i = 0; i < 5; i++) {
      await replicas[i % 2]!.deliver(decline(`evt_${i}`));
      if (i < 4)
        await expect(admit(replicas[(i + 1) % 2]!)).resolves.toMatchObject({
          processor_status: "requires_payment_method",
        });
      now += 100;
    }
    const restarted = runtime();
    for (const replica of [...replicas, restarted]) {
      await expect(admit(replica)).rejects.toMatchObject({ code: "rate_limited" });
      await expect(admit(replica, true)).rejects.toMatchObject({ code: "rate_limited" });
    }
    expect(restarted.gateway.createPaymentSession).not.toHaveBeenCalled();
    expect(await store().check("different_fingerprint")).toBeNull();
    expect((await state()).counters).toMatchObject([{ count: 5, reset_at: new Date(Date.parse(at) + 1000) }]);
    now = Date.parse(at) + 999;
    expect(await store().check("synthetic_fingerprint")).toEqual({ retryAfterSeconds: 1 });
    now++;
    await expect(admit(restarted, true)).resolves.toMatchObject({ processor_status: "requires_payment_method" });
    await restarted.deliver(decline("evt_next_window"));
    expect((await state()).counters).toMatchObject([{ count: 1, reset_at: new Date(now + 1000) }]);
  });

  it("races distinct and identical webhook deliveries without lost counts or sliding expiry", async () => {
    await runtime().deliver(decline("evt_anchor"));
    now += 200;
    const replicas = [runtime(), runtime()];
    await Promise.all(Array.from({ length: 12 }, (_, i) => replicas[i % 2]!.deliver(decline(`evt_race_${i % 6}`))));
    expect(await state()).toMatchObject({
      receipts: 7,
      inbox: 7,
      payment: "failed",
      counters: [{ count: 7, reset_at: new Date(Date.parse(at) + 1000) }],
    });
    await runtime().deliver(decline("evt_race_1"));
    expect((await state()).counters[0]!.count).toBe(7);
    expect((await state()).counters[0]!.fingerprint_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(signals)).not.toMatch(/synthetic_fingerprint|synthetic private|[a-f0-9]{64}/);
  });

  it.each(["counter", "aggregate", "inbox-commit"] as const)(
    "retries a %s failure without losing or duplicating the decline",
    async (stage) => {
      let inboxStarted = false;
      const database = fault((sql) => {
        if (sql.includes("INSERT INTO payments_provider_webhook_events")) inboxStarted = true;
        return stage === "counter"
          ? sql.includes("INSERT INTO payments_card_decline_counters")
          : stage === "aggregate"
            ? sql.includes("INSERT INTO event_store_events")
            : inboxStarted && sql === "COMMIT";
      });
      const event = decline("evt_retry");
      await expect(runtime(database).deliver(event)).rejects.toMatchObject({
        failureClass: "handler-failure",
        retryable: true,
      });
      const failed = await state();
      expect(failed).toMatchObject({
        receipts: stage === "counter" ? 0 : 1,
        inbox: 0,
        payment: "pending-confirmation",
      });
      expect(failed.counters).toHaveLength(stage === "counter" ? 0 : 1);
      await runtime().deliver(event);
      expect(await state()).toMatchObject({ receipts: 1, inbox: 1, payment: "failed", counters: [{ count: 1 }] });
      expect(JSON.stringify(signals)).not.toMatch(/synthetic private|synthetic_fingerprint/);
    },
  );

  it("fails closed for shared reads on creation and recovery before any provider call", async () => {
    const database: PgTransactionalPool = {
      connect: pool.connect.bind(pool),
      query: ((sql: string, values?: readonly unknown[]) => {
        if (sql.includes("FROM payments_card_decline_counters")) throw new Error("synthetic private database detail");
        return pool.query(sql, values);
      }) as PgQueryFunction,
    };
    const replica = runtime(database);
    for (const recover of [false, true])
      await expect(admit(replica, recover)).rejects.toMatchObject({
        code: "payment_decline_limit_unavailable",
        message: "Payment attempts are temporarily unavailable. Please retry later.",
      });
    expect(replica.gateway.createPaymentSession).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ receipts: 0, inbox: 0, counters: [] });
  });

  it("rejects same-identity different facts, separates processors, and never recounts expired receipts", async () => {
    const event = decline("evt_identity");
    await pool.query(
      `INSERT INTO payments_card_decline_events VALUES ('synthetic-other-processor', 'evt_identity', 'synthetic-only-receipt')`,
    );
    await store().record(event);
    for (const changed of [
      { ...event, processorPaymentReference: "pi_other" },
      { ...event, failureCode: "other" },
      decline("evt_identity", "other_fingerprint"),
    ]) {
      await expect(store().record(changed)).rejects.toThrow("Card decline event facts conflict.");
    }
    expect((await state()).counters[0]!.count).toBe(1);
    now += 1000;
    await store().record(event);
    expect(await store().check("synthetic_fingerprint")).toBeNull();
    expect((await state()).receipts).toBe(2);
  });

  it("preserves configured rules, unknown fingerprints and success while bounding expiry cleanup", async () => {
    const configured = store(pool, { max: 2, windowMs: 2000 });
    await configured.record(decline("evt_a"));
    expect(await configured.check("synthetic_fingerprint")).toBeNull();
    await configured.record(decline("evt_b"));
    expect(await configured.check(" synthetic_fingerprint ")).toEqual({ retryAfterSeconds: 2 });
    expect(await store(pool, { max: 3, windowMs: 100 }).check("synthetic_fingerprint")).toBeNull();
    expect((await state()).counters[0]!.reset_at).toEqual(new Date(now + 2000));
    for (const event of [
      decline("evt_blank", " "),
      { ...decline("evt_success"), kind: "payment-captured" as const },
      { ...decline("evt_unknown"), savedPaymentMethod: null },
    ])
      await configured.record(event);
    expect(await configured.check(null)).toBeNull();
    expect(await configured.check(" ")).toBeNull();
    expect((await state()).receipts).toBe(2);
    await pool.query(
      `INSERT INTO payments_card_decline_counters (fingerprint_digest, decline_count, reset_at)
      SELECT 'synthetic_expired_' || n, 1, $1 FROM generate_series(1, 205) n`,
      [new Date(now - 1)],
    );
    await configured.record(decline("evt_cleanup", "other_fingerprint"));
    expect((await state()).counters).toHaveLength(107);
    await configured.record(decline("evt_cleanup_2", "other_fingerprint"));
    expect((await state()).counters).toHaveLength(7);
    await configured.record(decline("evt_cleanup_3", "other_fingerprint"));
    expect((await state()).counters).toHaveLength(2);
    expect(await configured.check("synthetic_fingerprint")).not.toBeNull();
  });
});

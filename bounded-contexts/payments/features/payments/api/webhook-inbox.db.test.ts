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
  type PgTransactionalPool,
  type PgQueryFunction,
} from "@chase-sets/event-core-postgres";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PaymentProcessorGateway, PaymentProcessorWebhookEvent } from "@chase-sets/payment-processing";
import type { ProviderWebhookTelemetryEvent } from "@chase-sets/http/provider-errors";
import { module as paymentsModule } from "../../../index";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import { buildPaymentProjectionHandlers } from "../read-model/projection";

const context = {
  tenantId: "tnt_webhook" as never,
  audit: { performedByUserId: "usr_webhook" as never, forAccountId: "acc_webhook" as never },
};
const at = "2026-09-29T00:00:00.000Z";
const streamId = "payments.payment-pay_webhook";
function event(overrides: Partial<PaymentProcessorWebhookEvent> = {}): PaymentProcessorWebhookEvent {
  return {
    eventId: "evt_webhook",
    kind: "payment-authorized",
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference: "pi_webhook",
    internalPaymentId: "pay_webhook" as never,
    processorStatus: "succeeded",
    failureCode: null,
    failureMessage: null,
    occurredAt: at,
    ...overrides,
  };
}
const method = {
  processorName: "stripe" as const,
  providerCustomerReference: "cus_webhook",
  providerReference: "pm_webhook",
  paymentMethodCategory: "card" as const,
  displayLabel: "Synthetic card",
  readiness: "ready" as const,
  allowRedisplay: "always" as const,
  removed: false,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("payments atomic webhook inbox (real Postgres)", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let signals: ProviderWebhookTelemetryEvent[];
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected provider write in hermetic webhook test.");
  };
  function services(events: readonly PaymentProcessorWebhookEvent[], database = pool) {
    const parseWebhook = vi.fn<PaymentProcessorGateway["parseWebhook"]>();
    for (const item of events) parseWebhook.mockResolvedValueOnce(item);
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
      detachSavedPaymentMethod: vi.fn(async () => null),
      createPaymentSession: unused,
      cancelPayment: unused,
      retrievePaymentResult: unused,
      createRefund: vi.fn(async () => ({
        processorName: "stripe" as const,
        processorRefundReference: "re_webhook",
        processorStatus: "pending",
      })),
      submitDisputeEvidence: unused,
      parseWebhook,
    } satisfies PaymentProcessorGateway;
    const runtime = createPaymentsServices(database, {
      processorGateway: gateway,
      webhookTelemetry: {
        record: (signal) => {
          signals.push(signal);
        },
      },
    });
    return {
      ...runtime,
      gateway,
      deliver: () => runtime.payments.processWebhook({ rawBody: "{}", signatureHeader: "synthetic" }, context),
    };
  }
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required for webhook inbox DB proof.");
    const urls = createMultiContextTestDatabaseUrls(url, ["payments"], "webhook_inbox");
    await ensureMultiContextTestDatabases(url, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.payments;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pool);
    signals = [];
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function project() {
    const handlers = buildPaymentProjectionHandlers(pool);
    const history = await createPostgresEventStore({ pool }).readStream({ streamId });
    for (const stored of history) await handlers[stored.eventType]?.(toTransportEvent(stored));
  }
  async function seed(captured = false) {
    const runtime = services([]);
    await runtime.payments.commandHandler({
      streamId,
      context,
      command: {
        type: "CreatePayment",
        paymentId: "pay_webhook" as never,
        buyerAccountId: "acc_webhook" as never,
        orderIds: ["ord_webhook" as never],
        amount: "10.00",
        marketplaceSalesFeeAmount: "1.00",
        marketplaceCheckoutFeeAmount: "0.50",
        sellerNetAmount: "8.50",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: "pi_webhook",
        processorClientSecret: null,
        processorStatus: "requires_payment_method",
        createdAt: at,
      },
    });
    if (captured)
      await runtime.payments.commandHandler({
        streamId,
        context,
        command: { type: "RecordPaymentCapture", processorStatus: "succeeded", capturedAt: at },
      });
    await project();
  }
  async function counts() {
    const result = await pool.query<{ inbox: number; events: number; instruments: number; audits: number }>(`SELECT
      (SELECT count(*)::int FROM payments_provider_webhook_events) AS inbox,
      (SELECT count(*)::int FROM event_store_events) AS events,
      (SELECT count(*)::int FROM payments_saved_checkout_instruments) AS instruments,
      (SELECT count(*)::int FROM payments_saved_checkout_instrument_audit) AS audits`);
    return result.rows[0];
  }
  function intercept(
    query: (
      sql: string,
      values: readonly unknown[] | undefined,
      execute: () => ReturnType<PgQueryFunction>,
    ) => ReturnType<PgQueryFunction>,
  ): PgTransactionalPool {
    return {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: ((sql: string, values?: readonly unknown[]) =>
            query(sql, values, () => client.query(sql, values))) as PgQueryFunction,
        };
      },
    };
  }

  it("concurrent duplicate webhook deliveries append once", async () => {
    await seed();
    const claimed = deferred();
    const release = deferred();
    const winnerPool = intercept(async (sql, _values, execute) => {
      const result = await execute();
      if (sql.includes("INSERT INTO payments_provider_webhook_events")) {
        claimed.resolve();
        await release.promise;
      }
      return result;
    });
    const winner = services([event()], winnerPool);
    const contended = deferred();
    const loser = services(
      [event()],
      intercept(async (sql, _values, execute) => {
        if (sql.includes("INSERT INTO payments_provider_webhook_events")) contended.resolve();
        return execute();
      }),
    );
    const first = winner.deliver();
    await claimed.promise;
    const second = loser.deliver();
    await contended.promise;
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { received: true, ignored: false },
      { received: true, ignored: true, failure_class: "inbox-conflict" },
    ]);
    expect(await counts()).toEqual({ inbox: 1, events: 2, instruments: 0, audits: 0 });
    expect(loser.gateway.createRefund).not.toHaveBeenCalled();
  });

  it("winner rollback lets a concurrent claimant process and retry", async () => {
    await seed();
    const entered = deferred();
    const release = deferred();
    const failedPool = intercept(async (sql, _values, execute) => {
      if (sql === "COMMIT") {
        entered.resolve();
        await release.promise;
        throw new Error("synthetic commit failure");
      }
      return execute();
    });
    const failed = services([event()], failedPool)
      .deliver()
      .catch((error: unknown) => error);
    await entered.promise;
    const contended = deferred();
    const retry = services(
      [event()],
      intercept(async (sql, _values, execute) => {
        if (sql.includes("INSERT INTO payments_provider_webhook_events")) contended.resolve();
        return execute();
      }),
    ).deliver();
    await contended.promise;
    release.resolve();
    expect(await failed).toMatchObject({ failureClass: "handler-failure", retryable: true });
    expect(await retry).toEqual({ received: true, ignored: false });
    expect(await counts()).toMatchObject({ inbox: 1, events: 2 });
    expect(signals.filter((signal) => signal.invariantCode)).toEqual([]);
  });

  it("different event IDs sharing a target serialize before complete-stream reads", async () => {
    await seed();
    const runtime = services([event({ eventId: "evt_a" }), event({ eventId: "evt_b" })]);
    expect(await Promise.all([runtime.deliver(), runtime.deliver()])).toEqual([
      { received: true, ignored: false },
      { received: true, ignored: false },
    ]);
    expect(await counts()).toMatchObject({ inbox: 2, events: 2 });
  });

  it("transient handler failure leaves the inbox unrecorded", async () => {
    await seed();
    const baseline = await counts();
    const item = event({ kind: "payment-captured", savedPaymentMethod: method });
    const failing = intercept(async (sql, _values, execute) => {
      if (sql === "COMMIT") throw new Error("signature secret_SYNTHETIC_DO_NOT_LOG");
      return execute();
    });
    await runWithEventCommitMetadata(async () => {
      await expect(services([item], failing).deliver()).rejects.toMatchObject({
        failureClass: "handler-failure",
        retryable: true,
      });
      expect(getEventCommitMetadata().eventIds).toEqual([]);
    });
    expect(await counts()).toEqual(baseline);
    expect(JSON.stringify(signals)).not.toContain("secret_SYNTHETIC_DO_NOT_LOG");
    await runWithEventCommitMetadata(async () => {
      await services([item]).deliver();
      expect(getEventCommitMetadata().committedEvents.map((entry) => entry.eventType)).toContain(
        "payments.payment-captured",
      );
    });
    expect(await counts()).toMatchObject({ inbox: 1, instruments: 1, audits: 1 });
  });

  it("later-command invariant rolls back earlier append, relational writes and metadata", async () => {
    await seed();
    const baseline = await counts();
    const item = event({
      kind: "payment-captured",
      savedPaymentMethod: method,
      liabilityShiftOutcome: { threeDSecureRequested: null, status: "" as never, authenticationResult: null },
    });
    await runWithEventCommitMetadata(async () => {
      expect(await services([item]).deliver()).toEqual({
        received: true,
        ignored: true,
        failure_class: "handler-failure",
      });
      expect(getEventCommitMetadata().eventIds).toEqual([]);
    });
    expect(await counts()).toEqual({ ...baseline, inbox: 1 });
    expect(signals).toEqual([
      expect.objectContaining({
        failureClass: "handler-failure",
        outcome: "ignored",
        invariantCode: "RecordPaymentLiabilityShiftOutcome:validation_failed",
      }),
    ]);
    await services([item]).deliver();
    expect(signals.filter((signal) => signal.invariantCode)).toHaveLength(1);
  });

  it("a failed invariant inbox commit emits no invariant signal", async () => {
    await seed(true);
    const failing = intercept(async (sql, _values, execute) => {
      if (sql === "COMMIT") throw new Error("synthetic commit failure");
      return execute();
    });
    await expect(services([event({ kind: "payment-failed" })], failing).deliver()).rejects.toMatchObject({
      retryable: true,
    });
    expect(await counts()).toMatchObject({ inbox: 0 });
    expect(signals.filter((signal) => signal.invariantCode)).toEqual([]);
  });

  it("refund-before-capture retries instead of becoming a permanent ignore", async () => {
    await seed();
    const refund = event({
      kind: "payment-refunded",
      amount: "1.00",
      refundedAmount: "1.00",
      processorRefundReference: "re_webhook",
      orderIds: ["ord_webhook" as never],
    });
    const baseline = await counts();
    await expect(services([refund]).deliver()).rejects.toMatchObject({
      failureClass: "handler-failure",
      retryable: true,
    });
    expect(await counts()).toEqual(baseline);
    await services([event({ eventId: "evt_capture", kind: "payment-captured" })]).deliver();
    await services([refund]).deliver();
    const history = await createPostgresEventStore({ pool }).readStream({ streamId });
    expect(history.map((entry) => entry.eventType)).toContain("payments.payment-refunded");
  });

  it("multi-command early-fraud-warning refunds commit once", async () => {
    await seed(true);
    const warning = event({
      kind: "payment-early-fraud-warning",
      chargeDisputed: false,
      providerObjectReference: "issfr_webhook",
    });
    const runtime = services([warning, warning]);
    await runtime.deliver();
    await runtime.deliver();
    expect(runtime.gateway.createRefund).toHaveBeenCalledTimes(1);
    const history = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM event_store_events ORDER BY global_position",
    );
    expect(history.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "payments.payment-fraud-warning-received",
        "payments.payment-refund-requested",
        "payments.refund-requested",
      ]),
    );
    expect(await counts()).toMatchObject({ inbox: 1 });
  });

  async function setup(reference: string) {
    await pool.query(
      `INSERT INTO payments_saved_checkout_setup_sessions
      (setup_reference_id, account_id, provider, provider_customer_reference, processor_setup_reference, processor_status, consent_id, consent_text)
      VALUES ($1, 'acc_webhook', 'stripe', 'cus_webhook', $1, 'open', 'consent_webhook', 'synthetic consent')`,
      [reference],
    );
  }

  it.each([
    "shared-payment-token-used",
    "shared-payment-token-deactivated",
    "saved-payment-setup-succeeded",
    "saved-payment-setup-failed",
    "saved-payment-method-detached",
    "payment-cancelled",
    "payment-authorized",
  ] as const)("no-append outcomes are still recorded: %s", async (kind) => {
    await seed(true);
    await setup("seti_webhook");
    const item = event({
      kind,
      processorPaymentKind: kind === "payment-cancelled" ? "checkout-session" : "payment-intent",
      processorSetupReference: "seti_webhook",
      savedPaymentMethod: kind === "saved-payment-method-detached" ? method : null,
    });
    const baseline = await counts();
    const runtime = services([item, { ...item, occurredAt: "2026-09-30T00:00:00.000Z" }]);
    await runtime.deliver();
    expect(await counts()).toEqual({ ...baseline, inbox: 1 });
    expect(await runtime.deliver()).toMatchObject({ ignored: true, failure_class: "inbox-conflict" });
    expect(await counts()).toEqual({ ...baseline, inbox: 1 });
    expect(runtime.gateway.parseWebhook).toHaveBeenCalledTimes(2);
    expect(runtime.gateway.detachSavedPaymentMethod).not.toHaveBeenCalled();
    expect(runtime.gateway.createRefund).not.toHaveBeenCalled();
  });

  it("concurrent setup success on an empty account retains exactly one default", async () => {
    await setup("seti_a");
    await setup("seti_b");
    const a = event({
      kind: "saved-payment-setup-succeeded",
      eventId: "evt_a",
      processorPaymentReference: "seti_a",
      savedPaymentMethod: method,
    });
    const b = event({
      ...a,
      eventId: "evt_b",
      processorPaymentReference: "seti_b",
      savedPaymentMethod: { ...method, providerReference: "pm_b" },
    });
    const runtime = services([a, b]);
    await Promise.all([runtime.deliver(), runtime.deliver()]);
    const defaults = await pool.query(
      "SELECT instrument_id FROM payments_saved_checkout_instruments WHERE is_default = true",
    );
    expect(defaults.rows).toHaveLength(1);
    expect(await counts()).toEqual({ inbox: 2, events: 0, instruments: 2, audits: 2 });
  });

  it("detach present and next-day replay commit removal and audit only once", async () => {
    await setup("seti_webhook");
    await services([
      event({
        kind: "saved-payment-setup-succeeded",
        processorSetupReference: "seti_webhook",
        savedPaymentMethod: method,
      }),
    ]).deliver();
    const detached = event({
      kind: "saved-payment-method-detached",
      eventId: "evt_detached",
      savedPaymentMethod: method,
    });
    const runtime = services([detached, detached]);
    await runtime.deliver();
    expect(await runtime.deliver()).toMatchObject({ failure_class: "inbox-conflict" });
    expect(await counts()).toEqual({ inbox: 2, events: 0, instruments: 1, audits: 2 });
    const instruments = await pool.query<{ readiness: string }>(
      "SELECT readiness FROM payments_saved_checkout_instruments",
    );
    expect(instruments.rows[0].readiness).toBe("removed");
  });

  it.each(["recorded-only", "mismatched", "missing-identity", "repeated-create", "out-of-order"])(
    "poison history remains retryable: %s",
    async (kind) => {
      await seed();
      const store = createPostgresEventStore({ pool });
      const [created] = await store.readStream({ streamId });
      if (kind === "recorded-only" || kind === "out-of-order") {
        await pool.query(
          "UPDATE event_store_events SET event_type = 'payments.payment-authorized', payload = $1::jsonb WHERE stream_id = $2 AND stream_version = 1",
          [JSON.stringify({ paymentId: "pay_webhook", authorizedAt: at }), streamId],
        );
      }
      if (kind === "mismatched") {
        await pool.query(
          "UPDATE event_store_events SET payload = jsonb_set(payload, '{paymentId}', '\"pay_other\"') WHERE stream_id = $1",
          [streamId],
        );
      }
      if (kind === "missing-identity") {
        await pool.query("UPDATE event_store_events SET payload = payload - 'paymentId' WHERE stream_id = $1", [
          streamId,
        ]);
      }
      if (kind === "repeated-create" || kind === "out-of-order") {
        await store.appendToStream({
          streamId,
          expectedVersion: 1,
          context,
          events: [{ eventType: created.eventType, payload: created.payload }],
        });
      }
      const baseline = await counts();
      await expect(services([event()]).deliver()).rejects.toMatchObject({
        failureClass: "handler-failure",
        retryable: true,
      });
      expect(await counts()).toEqual(baseline);
      expect(signals.filter((signal) => signal.invariantCode)).toEqual([]);
    },
  );

  it("empty history and terminal-state decider rejections commit inbox only", async () => {
    await seed(true);
    const baseline = await counts();
    await services([event({ kind: "payment-failed" })]).deliver();
    expect(await counts()).toEqual({ ...baseline, inbox: 1 });
    await pool.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
    await pool.query("DELETE FROM event_store_streams WHERE stream_id = $1", [streamId]);
    expect(await services([event({ eventId: "evt_empty", kind: "payment-failed" })]).deliver()).toMatchObject({
      ignored: true,
    });
    expect(await counts()).toMatchObject({ inbox: 2, events: 0 });
  });

  it("unexpected history stays retryable rather than being tagged by error type", async () => {
    await seed();
    await createPostgresEventStore({ pool }).appendToStream({
      streamId,
      expectedVersion: 1,
      context,
      events: [{ eventType: "synthetic.unexpected", payload: { secret: "SYNTHETIC_SECRET" } }],
    });
    await expect(services([event()]).deliver()).rejects.toMatchObject({
      failureClass: "handler-failure",
      retryable: true,
    });
    expect(await counts()).toMatchObject({ inbox: 0, events: 2 });
    expect(signals.filter((signal) => signal.invariantCode)).toEqual([]);
    expect(JSON.stringify(signals)).not.toContain("SYNTHETIC_SECRET");
  });
});

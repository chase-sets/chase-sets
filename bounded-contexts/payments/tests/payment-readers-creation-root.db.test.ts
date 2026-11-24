import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import {
  createPaymentTransactionRunner,
  createPaymentWebhookRunner,
  paymentLockKey,
} from "../features/payments/api/webhook-transaction";
import { buildPaymentProjectionHandlers } from "../features/payments/read-model/projection";
import { module as paymentsModule } from "../index";
import { createPaymentsServices } from "../support/runtime-support/services";

const context = {
  tenantId: "tnt_payment_lock" as never,
  audit: { performedByUserId: "usr_payment_lock" as never, forAccountId: "acc_payment_lock" as never },
};
const at = "2026-11-24T00:00:00.000Z";
const paymentId = "pay_lock";
const streamId = "payments.payment-pay_lock";
const legacy = "payments.payment-created";
const creationRecorded = "payments.payment.creation-recorded.v1";
const refundRequested = "payments.refund-requested";
const authorized = "payments.payment-authorized";
const accepted = { received: true, ignored: false };

function inbox(providerEventId: string) {
  return { tableName: "payments_provider_webhook_events", providerEventId, providerName: "stripe", eventKind: "test" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function createCommand(id: string) {
  return {
    streamId: `payments.payment-${id}`,
    context,
    command: {
      type: "CreatePayment" as const,
      paymentId: id as never,
      buyerAccountId: "acc_payment_lock" as never,
      orderIds: ["ord_payment_lock" as never],
      amount: "10.00",
      marketplaceSalesFeeAmount: "1.00",
      marketplaceCheckoutFeeAmount: "0.50",
      sellerNetAmount: "8.50",
      currencyCode: "usd" as const,
      processorName: "stripe" as const,
      processorPaymentKind: "checkout-session" as const,
      processorPaymentReference: `pi_${id}`,
      processorClientSecret: null,
      processorStatus: "open",
      createdAt: at,
    },
  };
}

describe("Payment reader roots and locks over Postgres", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  const store = () => createPostgresEventStore({ pool });
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required for Payment reader DB proof.");
    const urls = createMultiContextTestDatabaseUrls(url, ["payments"], "payment_reader_roots");
    await ensureMultiContextTestDatabases(url, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.payments;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pool);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("payment-webhook-accepts-both-roots and keeps the refund root rule", async () => {
    const cases = [
      { label: "legacy", events: [legacy, authorized], accept: true },
      { label: "creation-recorded", events: [creationRecorded, authorized], accept: true },
      { label: "duplicate legacy", events: [legacy, legacy] },
      { label: "duplicate creation-recorded", events: [creationRecorded, creationRecorded] },
      { label: "late creation-recorded", events: [legacy, authorized, creationRecorded] },
      { label: "late legacy", events: [creationRecorded, authorized, legacy] },
      { label: "unknown first type", events: [authorized] },
      { label: "wrong root id", events: [creationRecorded], wrongAt: 0 },
      { label: "wrong later id", events: [legacy, authorized], wrongAt: 1 },
      { label: "refund", events: [refundRequested], refund: true, accept: true },
      { label: "duplicate refund", events: [refundRequested, refundRequested], refund: true },
      { label: "Payment root on refund", events: [creationRecorded], refund: true },
      { label: "wrong refund id", events: [refundRequested], refund: true, wrongAt: 0 },
    ];
    const eventStore = store();
    const run = createPaymentWebhookRunner(pool, eventStore);
    for (const [index, entry] of cases.entries()) {
      const id = `${entry.refund ? "rfd" : "pay"}_${index}`;
      const streamId = `payments.${entry.refund ? "refund" : "payment"}-${id}`;
      await eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context,
        events: entry.events.map((eventType, offset) => ({
          eventType,
          payload: { [entry.refund ? "refundId" : "paymentId"]: offset === entry.wrongAt ? "wrong" : id },
        })),
      });
      const processed = run(inbox(`evt_root_${index}`), async ({ eventStore }) => {
        const history = await eventStore.readStream({ streamId });
        expect(
          history.map((event) => event.eventType),
          entry.label,
        ).toEqual(entry.events);
        return accepted;
      });
      if (entry.accept) await expect(processed, entry.label).resolves.toMatchObject({ result: accepted });
      else await expect(processed, entry.label).rejects.toThrow("Payment webhook aggregate history is inconsistent.");
    }
  });

  async function backendPid(db: PgQueryable) {
    return (await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  }

  function observePaymentLock(onAttempt: (pid: number) => void, refusePoolPaymentRead = false): PgTransactionalPool {
    return {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        if (refusePoolPaymentRead && sql.includes("payments_payment_pages")) {
          throw new Error("Payment webhook must not use the pool to read Payment state.");
        }
        return pool.query<Row>(sql, values);
      },
      async connect() {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          async query<Row>(sql: string, values?: readonly unknown[]) {
            if (sql.includes("pg_advisory_xact_lock") && String(values?.[0]).endsWith(paymentLockKey(paymentId))) {
              onAttempt(await backendPid(client));
            }
            return client.query<Row>(sql, values);
          },
        };
      },
    };
  }

  async function expectBlocked(waiter: number, owner: number) {
    await expect
      .poll(async () => {
        const { rows } = await pool.query<{ blocked: boolean }>("SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked", [
          owner,
          waiter,
        ]);
        return rows[0]?.blocked;
      })
      .toBe(true);
  }

  it("payment-lock-shared-across-runners: a webhook blocks only the same Payment command", async () => {
    const held = deferred<number>();
    const release = deferred<void>();
    const attempt = deferred<number>();
    const webhook = createPaymentWebhookRunner(pool, store());
    const owner = webhook(inbox("evt_holder"), async (tx) => {
      await tx.lock(paymentLockKey(paymentId));
      held.resolve(await backendPid(tx.db));
      await release.promise;
      return accepted;
    });
    const ownerPid = await held.promise;
    const commands = createPaymentsServices(observePaymentLock(attempt.resolve)).payments;
    const same = commands.commandHandler(createCommand(paymentId));
    const different = commands.commandHandler(createCommand("pay_different"));
    try {
      await expectBlocked(await attempt.promise, ownerPid);
      await expect(different).resolves.toMatchObject({ version: 1 });
    } finally {
      release.resolve();
      await Promise.allSettled([owner, same, different]);
    }
    await expect(owner).resolves.toMatchObject({ result: accepted });
    await expect(same).resolves.toMatchObject({ version: 1 });
  });

  it("payment-lock-shared-across-runners: webhook rereads the row and stream after the command commits", async () => {
    const eventStore = store();
    const seeded = await createPaymentsServices(pool).payments.commandHandler(createCommand(paymentId));
    const handlers = buildPaymentProjectionHandlers(pool);
    await handlers[legacy]!(toTransportEvent(seeded.storedEvents[0]!));
    const hold = deferred<number>();
    const release = deferred<void>();
    const attempt = deferred<number>();
    const owner = createPaymentTransactionRunner(
      pool,
      eventStore,
    )(async (tx) => {
      await tx.lock(paymentLockKey(paymentId));
      await tx.db.query(
        "UPDATE payments_payment_pages SET processor_payment_kind = 'payment-intent' WHERE payment_id = $1",
        [paymentId],
      );
      await tx.eventStore.appendToStream({
        streamId,
        context,
        expectedVersion: 1,
        events: [
          { eventType: authorized, payload: { paymentId, processorStatus: "requires_capture", authorizedAt: at } },
        ],
      });
      hold.resolve(await backendPid(tx.db));
      await release.promise;
    });
    const unsupported = async (): Promise<never> => {
      throw new Error("Unexpected provider call.");
    };
    const processorGateway: PaymentProcessorGateway = {
      getPublicConfiguration: () => ({
        processorName: "stripe",
        publishableKey: null,
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      }),
      createCustomer: unsupported,
      createSetupSession: unsupported,
      retrieveSetupSessionResult: unsupported,
      cancelSetupSession: unsupported,
      retrieveSavedPaymentMethod: unsupported,
      detachSavedPaymentMethod: unsupported,
      createPaymentSession: unsupported,
      cancelPayment: unsupported,
      retrievePaymentResult: unsupported,
      createRefund: unsupported,
      parseWebhook: async () => ({
        eventId: "evt_after_command",
        kind: "payment-cancelled",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: `pi_${paymentId}`,
        internalPaymentId: paymentId as never,
        processorStatus: "canceled",
        failureCode: null,
        failureMessage: null,
        occurredAt: at,
      }),
    };
    const { payments } = createPaymentsServices(observePaymentLock(attempt.resolve, true), { processorGateway });
    const ownerPid = await hold.promise;
    const webhook = payments.processWebhook({ rawBody: "{}", signatureHeader: "synthetic" }, context);
    try {
      await expectBlocked(await attempt.promise, ownerPid);
    } finally {
      release.resolve();
      await Promise.allSettled([owner, webhook]);
    }
    await expect(owner).resolves.toBeUndefined();
    await expect(webhook).resolves.toEqual(accepted);
    expect((await eventStore.readStream({ streamId })).map((event) => event.eventType)).toEqual([
      legacy,
      authorized,
      "payments.payment-cancelled",
    ]);
  });
});

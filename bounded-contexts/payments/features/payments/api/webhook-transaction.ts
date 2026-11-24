import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  getEventCommitMetadata,
  recordCommittedEvents,
  runWithEventCommitMetadata,
} from "@chase-sets/event-core/consistency";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { recordProviderWebhookEvent, type ProviderWebhookInboxEntry } from "@chase-sets/provider-webhook-inbox";
import { PaymentWebhookInvariant } from "./webhook-errors";
import type { ProviderWebhookInvariantCode } from "@chase-sets/http/provider-errors";

export type PaymentWebhookResult = Readonly<{
  received: boolean;
  ignored: boolean;
  failure_class?: "inbox-conflict" | "handler-failure" | "unknown-event";
}>;

export type PaymentTransaction = Readonly<{
  db: PgQueryable;
  eventStore: EventStore;
  lock: (key: string) => Promise<void>;
}>;

export type PaymentWebhookTransaction = PaymentTransaction;

export const paymentLockKey = (paymentId: string) => `payment:${paymentId}`;

function transactionLock(client: PgQueryable) {
  return async (key: string) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payments:${key}`]);
  };
}

/**
 * Runs `work` in one database transaction: its rows and event appends commit or roll back
 * together, and `lock` takes a transaction-scoped advisory lock, so it serializes across replicas
 * and releases at commit or rollback.
 */
export type PaymentTransactionRunner = <T>(work: (transaction: PaymentTransaction) => Promise<T>) => Promise<T>;

export function createPaymentTransactionRunner(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
): PaymentTransactionRunner {
  return async (work) => {
    const committed = await withPgTransaction(pool, (client) =>
      runWithEventCommitMetadata(async () => {
        const result = await work({
          db: client,
          eventStore: {
            readStream: (input) => store.readStreamInTransaction(client, input),
            appendToStream: (input) => store.appendToStreamInTransaction(client, input),
            readAll: async () => {
              throw new Error("A payment transaction cannot read all streams.");
            },
          },
          lock: transactionLock(client),
        });
        return { result, events: getEventCommitMetadata().committedEvents };
      }),
    );
    recordCommittedEvents(committed.events);
    return committed.result;
  };
}

export function withPaymentLock<T>(
  run: PaymentTransactionRunner,
  paymentId: string,
  work: (transaction: PaymentTransaction) => Promise<T>,
): Promise<T> {
  return run(async (transaction) => {
    await transaction.lock(paymentLockKey(paymentId));
    return work(transaction);
  });
}

export type PaymentWebhookRunner = (
  entry: ProviderWebhookInboxEntry,
  process: (transaction: PaymentWebhookTransaction) => Promise<PaymentWebhookResult>,
) => Promise<Readonly<{ result: PaymentWebhookResult; invariantCode?: ProviderWebhookInvariantCode }>>;

export function createPaymentWebhookRunner(pool: PgTransactionalPool, store: PostgresEventStore): PaymentWebhookRunner {
  return async (entry, process) => {
    const committed = await withPgTransaction(pool, async (transactionClient) => {
      const client: PgQueryable = transactionClient;
      if (!(await recordProviderWebhookEvent(client, entry))) {
        return { result: { received: true, ignored: true, failure_class: "inbox-conflict" } as const, events: [] };
      }
      await client.query("SAVEPOINT payment_webhook_processing");
      try {
        return await runWithEventCommitMetadata(async () => {
          const eventStore: EventStore = {
            readStream: async (input) => {
              const events = await store.readStreamInTransaction(client, input);
              const payment = input.streamId.startsWith("payments.payment-");
              const prefix = payment ? "payments.payment-" : "payments.refund-";
              const idField = payment ? "paymentId" : "refundId";
              for (const event of events) {
                const root = payment
                  ? event.eventType === "payments.payment-created" ||
                    event.eventType === "payments.payment.creation-recorded.v1"
                  : event.eventType === "payments.refund-requested";
                if (
                  (event.streamVersion === 1) !== root ||
                  ((root || event.payload[idField] !== undefined) &&
                    event.payload[idField] !== input.streamId.slice(prefix.length))
                ) {
                  throw new Error("Payment webhook aggregate history is inconsistent.");
                }
              }
              return events;
            },
            appendToStream: (input) => store.appendToStreamInTransaction(client, input),
            readAll: async () => {
              throw new Error("Webhook processing cannot read all streams.");
            },
          };
          const result = await process({
            db: client,
            eventStore,
            lock: transactionLock(client),
          });
          return { result, events: getEventCommitMetadata().committedEvents };
        });
      } catch (error) {
        if (!(error instanceof PaymentWebhookInvariant)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT payment_webhook_processing");
        return {
          result: { received: true, ignored: true, failure_class: "handler-failure" } as const,
          invariantCode: error.invariantCode,
          events: [],
        };
      }
    });
    recordCommittedEvents(committed.events);
    return committed;
  };
}

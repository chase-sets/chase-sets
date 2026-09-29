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
  failure_class?: "inbox-conflict" | "handler-failure";
}>;

export type PaymentWebhookTransaction = Readonly<{
  db: PgQueryable;
  eventStore: EventStore;
  lock: (key: string) => Promise<void>;
}>;

export type PaymentWebhookRunner = (
  entry: ProviderWebhookInboxEntry,
  process: (transaction: PaymentWebhookTransaction) => Promise<PaymentWebhookResult>,
) => Promise<Readonly<{ result: PaymentWebhookResult; invariantCode?: ProviderWebhookInvariantCode }>>;

export function createPaymentWebhookRunner(pool: PgTransactionalPool, store: PostgresEventStore): PaymentWebhookRunner {
  return async (entry, process) => {
    const committed = await withPgTransaction(pool, async (client) => {
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
              const createdType = payment ? "payments.payment-created" : "payments.refund-requested";
              const idField = payment ? "paymentId" : "refundId";
              for (const event of events) {
                if (
                  (event.streamVersion === 1 && event.eventType !== createdType) ||
                  (event.streamVersion !== 1 && event.eventType === createdType) ||
                  (event.payload[idField] !== undefined &&
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
            lock: async (key) => {
              await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payments-webhook:${key}`]);
            },
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

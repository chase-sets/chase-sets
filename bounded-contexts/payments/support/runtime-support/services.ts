import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import { createPaymentRuntime } from "../../features/payments/api/runtime";
import { createRefundRuntime } from "../../features/refunds/api/runtime";
import type { PaymentProcessorGateway, PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";
import type { BalanceCreditResolver } from "../../features/payments/api/balance-credit-resolver";

export type PaymentsServiceOptions = Readonly<{
  processorGateway?: PaymentProcessorGateway;
  balanceCreditResolver?: BalanceCreditResolver;
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type PaymentsServices = Readonly<{
  payments: ReturnType<typeof createPaymentRuntime>;
  refunds: ReturnType<typeof createRefundRuntime>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

function createMissingProcessorGateway(): PaymentProcessorGateway {
  const fail = () => {
    throw new Error("Payments requires a payment processor gateway for buyer payment and refund flows.");
  };

  return {
    getPublicConfiguration: () => ({
      processorName: "stripe",
      publishableKey: null,
      confirmationExperience: "processor-managed-form",
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    }),
    createCustomer: async () => fail(),
    createSetupSession: async () => fail(),
    retrieveSetupSessionResult: async () => fail(),
    retrieveSavedPaymentMethod: async () => fail(),
    detachSavedPaymentMethod: async () => fail(),
    createPaymentSession: async () => fail(),
    createRefund: async () => fail(),
    parseWebhook: async () => fail(),
  };
}

export function createPaymentsServices(
  pool: PgTransactionalPool,
  options: PaymentsServiceOptions = {},
): PaymentsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "payments" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const processorGateway = options.processorGateway ?? createMissingProcessorGateway();
  const transactionalEmailOutbox = options.transactionalEmailOutbox ?? createPostgresTransactionalEmailOutbox({ db });

  const payments = createPaymentRuntime({
    eventStore,
    checkpointStore,
    db,
    processorGateway,
    balanceCreditResolver: options.balanceCreditResolver,
    transactionalEmailOutbox,
  });
  const refunds = createRefundRuntime({
    eventStore,
    checkpointStore,
    db,
    processorGateway,
    transactionalEmailOutbox,
  });

  return {
    payments,
    refunds,
    publicConfig: processorGateway.getPublicConfiguration(),
    projectors: [...payments.projectors, ...refunds.projectors],
    pool,
    db,
  };
}

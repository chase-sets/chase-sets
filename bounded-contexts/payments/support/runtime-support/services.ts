import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createPaymentRuntime } from "../../features/payments/api/runtime";
import { createRefundRuntime } from "../../features/refunds/api/runtime";
import type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
} from "./processor-gateway";

export type PaymentsServiceOptions = Readonly<{
  processorGateway?: PaymentProcessorGateway;
}>;

export type PaymentsServices = Readonly<{
  payments: ReturnType<typeof createPaymentRuntime>;
  refunds: ReturnType<typeof createRefundRuntime>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

function createMissingProcessorGateway(): PaymentProcessorGateway {
  const fail = () => {
    throw new Error(
      "Payments requires a payment processor gateway for buyer payment and refund flows.",
    );
  };

  return {
    getPublicConfiguration: () => ({ processorName: "stripe", publishableKey: null }),
    createPaymentIntent: async () => fail(),
    createRefund: async () => fail(),
    parseWebhook: async () => fail(),
  };
}

export function createPaymentsServices(
  pool: PgTransactionalPool,
  options: PaymentsServiceOptions = {},
): PaymentsServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const processorGateway = options.processorGateway ?? createMissingProcessorGateway();

  const payments = createPaymentRuntime({
    eventStore,
    checkpointStore,
    db,
    processorGateway,
  });
  const refunds = createRefundRuntime({
    eventStore,
    checkpointStore,
    db,
    processorGateway,
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

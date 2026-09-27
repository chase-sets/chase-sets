import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPaymentRuntime } from "../../features/payments/api/runtime";
import { createRefundRuntime } from "../../features/refunds/api/runtime";
import type { PaymentProcessorGateway, PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";
import type { BalanceCreditResolver } from "../../features/payments/api/balance-credit-resolver";
import type { CheckoutProcessingFeePolicyResolver } from "../../features/payments/api/checkout-processing-fee-policy-resolver";
import type { ProviderWebhookTelemetry } from "@chase-sets/http/provider-errors";
import type { ProviderModeObservation } from "../../features/payments/api/contracts";
import {
  createWalletFundingRuntime,
  type WalletFundingEligibilityResolver,
  type WalletFundingServices,
} from "../../features/wallet-funding/api/runtime";
import type { PrepaidRefundAuthority } from "../../features/wallet-funding/api/prepaid-refund-authority";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { walletFundingLimitsPolicy } from "../../features/wallet-funding/api/limits-policy";

export type PaymentsServiceOptions = Readonly<{
  prepaidRefundAuthority?: PrepaidRefundAuthority;
  walletFundingEligibilityResolver?: WalletFundingEligibilityResolver;
  processorGateway?: PaymentProcessorGateway;
  balanceCreditResolver?: BalanceCreditResolver;
  checkoutProcessingFeePolicyResolver?: CheckoutProcessingFeePolicyResolver;
  notificationOutbox?: NotificationOutbox;
  webhookTelemetry?: ProviderWebhookTelemetry;
  providerModeObservation?: ProviderModeObservation;
}>;

export type PaymentsServices = Readonly<{
  policies: ReturnType<typeof createPolicyRuntime>;
  walletFunding: WalletFundingServices;
  payments: ReturnType<typeof createPaymentRuntime>;
  refunds: ReturnType<typeof createRefundRuntime>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
  providerModeObservation?: ProviderModeObservation;
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
    cancelSetupSession: async () => fail(),
    retrieveSavedPaymentMethod: async () => fail(),
    detachSavedPaymentMethod: async () => fail(),
    createPaymentSession: async () => fail(),
    cancelPayment: async () => fail(),
    retrievePaymentResult: async () => fail(),
    createRefund: async () => fail(),
    submitDisputeEvidence: async () => fail(),
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
  const notificationOutbox = options.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const policies = createPolicyRuntime({ eventStore, db });
  const walletFunding = createWalletFundingRuntime({
    eventStore,
    pool,
    processorGateway,
    prepaidRefundAuthority: options.prepaidRefundAuthority,
    walletFundingEligibilityResolver: options.walletFundingEligibilityResolver,
    checkoutProcessingFeePolicyResolver: options.checkoutProcessingFeePolicyResolver,
    resolveLimits: async () => (await policies.resolvePolicy(walletFundingLimitsPolicy)).value,
  });

  const refunds = createRefundRuntime({
    eventStore,
    checkpointStore,
    db,
    processorGateway,
    notificationOutbox,
  });
  const payments = createPaymentRuntime({
    walletFunding,
    eventStore,
    checkpointStore,
    db,
    processorGateway,
    refunds,
    balanceCreditResolver: options.balanceCreditResolver,
    checkoutProcessingFeePolicyResolver: options.checkoutProcessingFeePolicyResolver,
    notificationOutbox,
    webhookTelemetry: options.webhookTelemetry,
  });

  return {
    policies,
    walletFunding,
    payments,
    refunds,
    publicConfig: processorGateway.getPublicConfiguration(),
    projectors: [...payments.projectors, ...refunds.projectors, ...walletFunding.projectors, ...policies.projectors],
    pool,
    db,
    ...(options.providerModeObservation ? { providerModeObservation: options.providerModeObservation } : {}),
  };
}

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
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createWalletRuntime } from "../../features/wallets/api/runtime";
import type { NegativeBalancePolicy } from "../../features/wallets/api/runtime";
import { createWalletAdjustmentRuntime } from "../../features/wallets/api/wallet-adjustment-runtime";
import { createProtectionCoverageRuntime } from "../../features/protection-coverage/api/protection-coverage-runtime";
import { createSupportHoldLifecycleRuntime } from "../../features/wallets/integrations/support-hold-lifecycle/support-hold-lifecycle-runtime";
import { createPayoutRuntime } from "../../features/payouts/api/runtime";
import { createPayoutReadinessRuntime } from "../../features/payout-readiness/api/runtime";
import { createLiabilityReconciliationRuntime } from "../../features/liability-reconciliation/api/runtime";
import { createAccountLinkageRuntime } from "../../features/wallets/api/account-linkage-runtime";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createNoopSettlementOperationsRecorder, type SettlementOperationsRecorder } from "./operations";
import type { PayoutDestinationFrictionPolicy, SensitiveActionVerifier } from "../../features/payouts/api/runtime";
import type { ProviderWebhookTelemetry } from "@chase-sets/http/provider-errors";

export type SettlementHostPorts = Readonly<{
  moneyMovementGateway?: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
  notificationOutbox?: NotificationOutbox;
  negativeBalancePolicy?: NegativeBalancePolicy;
  payoutDestinationFrictionPolicy?: Partial<PayoutDestinationFrictionPolicy>;
  sensitiveActionVerifier?: SensitiveActionVerifier;
  webhookTelemetry?: ProviderWebhookTelemetry;
}>;

export type SettlementServices = Readonly<{
  wallets: ReturnType<typeof createWalletRuntime>;
  walletAdjustments: ReturnType<typeof createWalletAdjustmentRuntime>;
  protectionCoverage: ReturnType<typeof createProtectionCoverageRuntime>;
  supportHoldLifecycle: ReturnType<typeof createSupportHoldLifecycleRuntime>;
  payouts: ReturnType<typeof createPayoutRuntime>;
  payoutReadiness: ReturnType<typeof createPayoutReadinessRuntime>;
  liabilityReconciliation: ReturnType<typeof createLiabilityReconciliationRuntime>;
  accountLinkage: ReturnType<typeof createAccountLinkageRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (clearance window, payout bounds). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

function createMissingMoneyMovementGateway(): MoneyMovementGateway {
  const fail = () => {
    throw new Error(
      "Settlement requires a money movement gateway for payout setup, payout, and provider webhook flows.",
    );
  };

  return {
    providerName: "unconfigured",
    ensurePayoutAccount: async () => fail(),
    createPayoutSetupSession: async () => fail(),
    createPayoutAccountManagementSession: async () => fail(),
    createPayoutNotificationBannerSession: async () => fail(),
    createPayoutSetupLink: async () => fail(),
    refreshPayoutReadiness: async () => fail(),
    retrievePlatformBalance: async () => fail(),
    transferPlatformBalanceToConnectedAccount: async () => fail(),
    createConnectedAccountPayout: async () => fail(),
    retrieveConnectedAccountPayout: async () => fail(),
    parseMoneyMovementWebhook: async () => fail(),
  };
}

export function createSettlementServices(
  pool: PgTransactionalPool,
  ports: SettlementHostPorts = {},
): SettlementServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "settlement" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const moneyMovementGateway = ports.moneyMovementGateway ?? createMissingMoneyMovementGateway();
  const operationsRecorder = ports.operationsRecorder ?? createNoopSettlementOperationsRecorder();
  const policies = createPolicyRuntime({ eventStore, db });
  const wallets = createWalletRuntime({
    eventStore,
    checkpointStore,
    db,
    policies,
    notificationOutbox,
    ...(ports.negativeBalancePolicy ? { negativeBalancePolicy: ports.negativeBalancePolicy } : {}),
  });
  const walletAdjustments = createWalletAdjustmentRuntime({ eventStore, db, wallets, policies, operationsRecorder });
  const protectionCoverage = createProtectionCoverageRuntime({ eventStore, db, operationsRecorder });
  const supportHoldLifecycle = createSupportHoldLifecycleRuntime({ eventStore });
  const payoutReadiness = createPayoutReadinessRuntime({
    eventStore,
    checkpointStore,
    db,
    moneyMovementGateway,
    operationsRecorder,
    notificationOutbox,
    payoutDestinationFrictionPolicy: ports.payoutDestinationFrictionPolicy,
    sensitiveActionVerifier: ports.sensitiveActionVerifier,
  });
  const payouts = createPayoutRuntime({
    eventStore,
    checkpointStore,
    db,
    wallets,
    payoutReadiness,
    moneyMovementGateway,
    operationsRecorder,
    notificationOutbox,
    policies,
    payoutDestinationFrictionPolicy: ports.payoutDestinationFrictionPolicy,
    sensitiveActionVerifier: ports.sensitiveActionVerifier,
    webhookTelemetry: ports.webhookTelemetry,
  });
  const liabilityReconciliation = createLiabilityReconciliationRuntime({ db, moneyMovementGateway });
  const accountLinkage = createAccountLinkageRuntime({ eventStore, db, policies });

  return {
    wallets,
    walletAdjustments,
    protectionCoverage,
    supportHoldLifecycle,
    payouts,
    payoutReadiness,
    liabilityReconciliation,
    accountLinkage,
    policies,
    projectors: [
      ...wallets.projectors,
      ...protectionCoverage.projectors,
      ...payoutReadiness.projectors,
      ...payouts.projectors,
      ...policies.projectors,
    ],
    pool,
    db,
  };
}

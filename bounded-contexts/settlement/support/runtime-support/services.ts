import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/notifications";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createWalletRuntime } from "../../features/wallets/api/runtime";
import { createPayoutRuntime } from "../../features/payouts/api/runtime";
import { createPayoutReadinessRuntime } from "../../features/payout-readiness/api/runtime";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createNoopSettlementOperationsRecorder, type SettlementOperationsRecorder } from "./operations";

export type SettlementHostPorts = Readonly<{
  moneyMovementGateway?: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
  notificationOutbox?: NotificationOutbox;
}>;

export type SettlementServices = Readonly<{
  wallets: ReturnType<typeof createWalletRuntime>;
  payouts: ReturnType<typeof createPayoutRuntime>;
  payoutReadiness: ReturnType<typeof createPayoutReadinessRuntime>;
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
  const wallets = createWalletRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const payoutReadiness = createPayoutReadinessRuntime({
    eventStore,
    checkpointStore,
    db,
    moneyMovementGateway,
    operationsRecorder,
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
  });

  return {
    wallets,
    payouts,
    payoutReadiness,
    projectors: [...wallets.projectors, ...payoutReadiness.projectors, ...payouts.projectors],
    pool,
    db,
  };
}

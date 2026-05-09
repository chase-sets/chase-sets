import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import { createWalletRuntime } from "../../features/wallets/api/runtime";
import { createPayoutRuntime } from "../../features/payouts/api/runtime";
import { createPayoutReadinessRuntime } from "../../features/payout-readiness/api/runtime";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import {
  createNoopSettlementOperationsRecorder,
  type SettlementOperationsRecorder,
} from "../../features/payouts/api/operations";

export type SettlementHostPorts = Readonly<{
  moneyMovementGateway?: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type SettlementServices = Readonly<{
  wallets: ReturnType<typeof createWalletRuntime>;
  payouts: ReturnType<typeof createPayoutRuntime>;
  payoutReadiness: ReturnType<typeof createPayoutReadinessRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createSettlementServices(
  pool: PgTransactionalPool,
  ports: SettlementHostPorts = {},
): SettlementServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const transactionalEmailOutbox =
    ports.transactionalEmailOutbox ??
    createPostgresTransactionalEmailOutbox({ db });
  const moneyMovementGateway =
    ports.moneyMovementGateway ?? createFakeMoneyMovementGateway();
  const operationsRecorder =
    ports.operationsRecorder ?? createNoopSettlementOperationsRecorder();
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
  });
  const payouts = createPayoutRuntime({
    eventStore,
    checkpointStore,
    db,
    wallets,
    payoutReadiness,
    moneyMovementGateway,
    operationsRecorder,
    transactionalEmailOutbox,
  });

  return {
    wallets,
    payouts,
    payoutReadiness,
    projectors: [
      ...wallets.projectors,
      ...payoutReadiness.projectors,
      ...payouts.projectors,
    ],
    pool,
    db,
  };
}

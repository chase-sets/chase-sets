import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
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
  transactionalEmailGateway?: TransactionalEmailGateway;
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
    transactionalEmailGateway: ports.transactionalEmailGateway,
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

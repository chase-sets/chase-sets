import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createWalletRuntime } from "../../features/wallets/api/runtime";
import { createPayoutRuntime } from "../../features/payouts/api/runtime";

export type SettlementServices = Readonly<{
  wallets: ReturnType<typeof createWalletRuntime>;
  payouts: ReturnType<typeof createPayoutRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createSettlementServices(
  pool: PgTransactionalPool,
): SettlementServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const wallets = createWalletRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const payouts = createPayoutRuntime({
    eventStore,
    checkpointStore,
    db,
    wallets,
  });

  return {
    wallets,
    payouts,
    projectors: [...wallets.projectors, ...payouts.projectors],
    pool,
    db,
  };
}

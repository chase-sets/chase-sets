import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createWalletRuntime } from "./runtime";
import type { WalletSpendHoldPort } from "./balance-credit-resolver";

/**
 * Builds the wallet write port that lets the cross-context balance-credit
 * resolver place and release buyer-spend holds directly against Settlement's own
 * wallet event store. This keeps Settlement the sole writer of its wallet
 * streams (Payments only ever holds the resolver port), while giving the
 * resolver -- which otherwise only reads Settlement's read model -- the
 * authoritative reservation write needed to close the concurrent-checkout race.
 *
 * The event store is wired with Settlement's wake-notification config so
 * spend-hold events wake Settlement's projections exactly like any other wallet
 * write. No projectors are run from this instance; it exists only to issue the
 * spend-hold commands.
 */
export function createSettlementWalletSpendHoldPort(pool: PgTransactionalPool): WalletSpendHoldPort {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "settlement" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const wallets = createWalletRuntime({ eventStore, checkpointStore, db: pool });
  return {
    placeSpendHold: wallets.placeSpendHold,
    releaseSpendHold: wallets.releaseSpendHold,
  };
}

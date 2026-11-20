import { accountScopedWorkerContext } from "@chase-sets/channels/server";

import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createInventoryExternalChannelSaleRecorderForPool,
  type RecordExternalChannelSale,
} from "@chase-sets/inventory/server";

export function createPlatformChannelSaleRecorder(
  pool: PgTransactionalPool,
  consumerPool?: PgTransactionalPool,
): RecordExternalChannelSale {
  return async (command) =>
    createInventoryExternalChannelSaleRecorderForPool(
      pool,
      accountScopedWorkerContext(command.accountId),
      consumerPool,
    )(command);
}

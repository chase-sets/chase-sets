import { channelProviderRegistry, module as channelsModule, type ChannelProviderRegistry } from "@chase-sets/channels";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createInventoryExternalChannelSaleRecorderForPool,
  type RecordExternalChannelSale,
} from "@chase-sets/inventory/server";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import type { WorkerRunner } from "@chase-sets/platform-runtime/worker";
import { createScheduledJobRunner } from "./scheduled-runners";

export function createPlatformChannelSaleRecorder(pool: PgTransactionalPool): RecordExternalChannelSale {
  return async (command) =>
    createInventoryExternalChannelSaleRecorderForPool(pool, accountScopedWorkerContext(command.accountId))(command);
}

export function createChannelsReconciliationRunners(
  input: Readonly<{
    services: ReturnType<typeof channelsModule.createServices>;
    controlPlane: PlatformControlPlane;
    registry?: ChannelProviderRegistry;
  }>,
): readonly WorkerRunner[] {
  return [
    createScheduledJobRunner("channels-drift-reconciliation", 60_000, input.controlPlane, async () => {
      const results = await input.services.reconciliation.reconcileDueConnections(
        {
          registry: input.registry ?? channelProviderRegistry,
          sourceAttempt: 1,
          healthAuthority: null,
          limit: 100,
        },
        accountScopedWorkerContext,
      );
      return results.length;
    }),
  ];
}

export function accountScopedWorkerContext(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_channels_worker" as never,
    audit: {
      performedByUserId: "usr_channels_worker" as never,
      forAccountId: accountId as never,
    },
  };
}

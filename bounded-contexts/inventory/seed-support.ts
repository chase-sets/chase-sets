import type { Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/dev-seeds";
import type { TenantId } from "@chase-sets/primitives/typed-ids";

export const seedContext: EventStoreContext = {
  tenantId: "tnt_seed_development" as TenantId,
  audit: {
    performedByUserId: demoIdentitySeedIds.userId,
    forAccountId: demoIdentitySeedIds.accountId,
  },
};

export async function sendSeedCommand<Command>(
  handler: (input: {
    streamId: string;
    command: Command;
    context: EventStoreContext;
  }) => Promise<unknown>,
  streamId: string,
  command: Command,
) {
  return handler({ streamId, command, context: seedContext });
}

export async function drainProjectors(
  label: string,
  projectors: readonly Projector[],
): Promise<void> {
  console.log(`Running ${label} projectors...`);
  let totalProcessed = 0;

  do {
    totalProcessed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      totalProcessed += result.processed;
    }
  } while (totalProcessed > 0);

  console.log(`${label} projections up to date.`);
}

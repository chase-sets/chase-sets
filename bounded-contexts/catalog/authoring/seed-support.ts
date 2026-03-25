import type { Projector } from "../../../contracts/event-core/projector";
import type { EventStoreContext } from "../../../contracts/event-core/storage";
import { createId } from "../../../contracts/primitives/typed-ids";
import type {
  AccountId,
  TenantId,
  UserId,
} from "../../../contracts/primitives/typed-ids";

export const seedContext: EventStoreContext = {
  tenantId: createId("tnt") as TenantId,
  audit: {
    performedByUserId: createId("usr") as UserId,
    forAccountId: createId("acc") as AccountId,
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
  let totalProcessed: number;
  do {
    totalProcessed = 0;
    for (const projector of projectors) {
      const result = await projector.runOnce();
      totalProcessed += result.processed;
    }
  } while (totalProcessed > 0);
  console.log(`${label} projections up to date.`);
}
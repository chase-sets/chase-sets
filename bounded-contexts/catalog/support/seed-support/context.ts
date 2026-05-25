import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

export const seedContext: EventStoreContext = {
  tenantId: createId("tnt") as TenantId,
  audit: {
    performedByUserId: createId("usr") as UserId,
    forAccountId: createId("acc") as AccountId,
  },
};

export async function sendSeedCommand<Command>(
  handler: (input: { streamId: string; command: Command; context: EventStoreContext }) => Promise<unknown>,
  streamId: string,
  command: Command,
) {
  return handler({ streamId, command, context: seedContext });
}

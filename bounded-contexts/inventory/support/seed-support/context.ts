import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import type { TenantId } from "@chase-sets/primitives/typed-ids";

export const seedContext: EventStoreContext = {
  tenantId: "tnt_seed_development" as TenantId,
  audit: {
    performedByUserId: demoIdentitySeedIds.userId,
    forAccountId: demoIdentitySeedIds.accountId,
  },
};

export async function sendSeedCommand<Command>(
  handler: (input: { streamId: string; command: Command; context: EventStoreContext }) => Promise<unknown>,
  streamId: string,
  command: Command,
) {
  return handler({ streamId, command, context: seedContext });
}

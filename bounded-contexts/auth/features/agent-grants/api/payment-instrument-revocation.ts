import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type RevokeAgentGrantPaymentInstruments = (
  params: Readonly<{ accountId: AccountId; agentGrantId: string; revokedAt?: string; operationId?: string }>,
  context: EventStoreContext,
) => Promise<Readonly<{ detached: number; alreadyRemoved: number; instrumentIds: readonly string[] }>>;

import type { EventStore } from "@chase-sets/event-core/event-store";
import { createIdentityListingPolicy } from "./listing-authority-policy";

/** Current read evidence only. A consuming command still requires an operation-bound reservation. */
export function createIdentityListingCurrentFacts(eventStore: EventStore, now = () => new Date()) {
  const policy = createIdentityListingPolicy(eventStore);
  return async (accountId: string, input: Readonly<{ maxAgeMs: number }>) => {
    if (!accountId.trim() || !Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0)
      throw new Error("Identity current seller facts require an account and a positive read-age budget.");
    const validBefore = new Date(now().getTime() + input.maxAgeMs).toISOString();
    const account = await policy.account(accountId);
    if (account.state.id !== accountId || !account.tenantId || !account.state.accountType)
      throw new Error("Identity current seller account history is missing or mismatched.");
    // @stream-read-contract bounded-contexts/identity/features/access-hub/api/listing-current-facts.test.ts
    const tail = await eventStore.readStream({
      streamId: account.streamId,
      fromVersion: Number(account.revision),
      limit: 2,
    });
    const generatedAt = now().toISOString();
    if (
      tail.length !== 1 ||
      tail[0]!.eventId !== account.lastEventId ||
      Date.parse(generatedAt) >= Date.parse(validBefore)
    )
      throw new Error("Identity current seller facts changed or exceeded their read-age budget.");
    return {
      value: {
        accountId,
        active: account.state.status === "active",
        badgeKeys: account.state.badges,
      },
      generatedAt,
      validBefore,
    };
  };
}

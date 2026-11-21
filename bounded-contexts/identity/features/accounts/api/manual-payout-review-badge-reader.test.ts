import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createIdentityManualPayoutReviewBadgeReader } from "./runtime";

describe("committed manual payout review badge reader", () => {
  it("replays the current Account badge from committed facts and refuses a missing account", async () => {
    const { eventStore } = createInMemoryEventStore();
    const read = createIdentityManualPayoutReviewBadgeReader(eventStore);
    const accountId = "acc_synthetic_badge";
    const streamId = `identity.account-${accountId}`;
    const context = {
      tenantId: "tnt_synthetic_badge",
      audit: { performedByUserId: "usr_synthetic_badge_admin", forAccountId: accountId },
    } as const;
    await expect(read(accountId)).rejects.toThrow("Committed Identity account is unavailable");

    await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "identity.account.created",
          payload: { accountId, accountType: "personal", name: "Synthetic seller", displayName: "Synthetic seller" },
        },
        { eventType: "identity.account.badge-assigned", payload: { badgeKey: "manual-payout-review" } },
      ],
    });
    await expect(read(accountId)).resolves.toBe(true);

    await eventStore.appendToStream({
      streamId,
      expectedVersion: 2,
      context,
      events: [{ eventType: "identity.account.badge-removed", payload: { badgeKey: "manual-payout-review" } }],
    });
    await expect(read(accountId)).resolves.toBe(false);
  });
});

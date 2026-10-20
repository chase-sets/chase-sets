import { describe, expect, it } from "vitest";
import manifest from "@chase-sets/platform-operations/context";

describe("account appeal worker interest", () => {
  it("resolves every source event to the platform-operations registry", () => {
    const subscriptions = (
      manifest.eventSubscriptions as readonly { projectionName: string; eventTypes: readonly string[] }[]
    ).filter((entry) => entry.projectionName === "account-appeal-interest-projection");
    const eventTypes = subscriptions.flatMap((entry) => entry.eventTypes);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "identity.account.suspended",
        "identity.account.reactivated",
        "identity.account.closed",
        "marketplace.listing.operator-unlisted",
        "marketplace.listing.auto-unlisted",
      ]),
    );
  });
});

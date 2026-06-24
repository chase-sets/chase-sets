import { describe, expect, it } from "vitest";
import { module as checkoutModule, contextManifest } from "../index";

describe("checkout Sell List projection subscriptions", () => {
  it("keeps Checkout-owned Sell List events and Marketplace offer facts in the same projection group", () => {
    const subscriptions = checkoutModule.buildSubscriptions?.({
      db: {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
    } as never);

    const sellListGroup = contextManifest.projectionGroups.find(
      (group) => group.projectionName === "checkout.sell-list-projection",
    );
    const sellListSubscriptions = subscriptions?.filter(
      (subscription) => subscription.projectionName === "checkout.sell-list-projection",
    );

    expect(sellListGroup?.sourceContextNames).toEqual(["checkout", "marketplace"]);
    expect(sellListSubscriptions?.map((subscription) => subscription.sourceContextName).sort()).toEqual([
      "checkout",
      "marketplace",
    ]);
    expect(
      sellListSubscriptions?.find((subscription) => subscription.sourceContextName === "checkout")?.eventTypes,
    ).toEqual([
      "checkout.sell-list.line-added",
      "checkout.sell-list.line-quantity-set",
      "checkout.sell-list.line-removed",
      "checkout.sell-list.checkout-confirmed",
    ]);
    expect(
      sellListSubscriptions?.find((subscription) => subscription.sourceContextName === "marketplace")?.eventTypes,
    ).toEqual(["marketplace.offer.accepted"]);
  });
});

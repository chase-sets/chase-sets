import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createSettlementPayoutReviewHoldPort } from "./payout-review-hold-port";
import { createPayoutReviewHoldRuntime } from "./payout-review-hold-runtime";

const operatorContext: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic_operator" as never, forAccountId: "acc_synthetic_operator" as never },
};
const input = {
  accountId: "acc_synthetic_seller",
  reason: "Risk alert alert_synthetic",
  sourceReference: "alert_synthetic",
};

describe("Settlement payout review hold port", () => {
  it("re-checks the operator permission before placing a risk-alert hold", async () => {
    const store = createInMemoryEventStore();
    const holds = createPayoutReviewHoldRuntime({ eventStore: store.eventStore });
    const port = createSettlementPayoutReviewHoldPort(() => holds);

    for (const actorPermissions of [[], ["reported-content.view"], ["payouts.platform.view"]]) {
      await expect(port.placeRiskAlertHold({ ...input, actorPermissions }, operatorContext)).rejects.toThrow(
        "Payout review hold permission is required.",
      );
    }
    expect(store.readAllEvents()).toEqual([]);

    await expect(
      port.placeRiskAlertHold(
        { ...input, actorPermissions: ["reported-content.view", "payout-review-holds.manage"] },
        operatorContext,
      ),
    ).resolves.toEqual({ outcome: "placed", version: 1 });
    expect(store.readAllEvents().map((event) => [event.eventType, event.payload, event.performedByUserId])).toEqual([
      [
        "settlement.payout-review-hold.placed",
        {
          factSchemaVersion: 1,
          accountId: "acc_synthetic_seller",
          reason: "Risk alert alert_synthetic",
          source: "risk-alert",
          sourceReference: "alert_synthetic",
        },
        "usr_synthetic_operator",
      ],
    ]);
  });

  it("refuses when Settlement is not composed on the host", async () => {
    const port = createSettlementPayoutReviewHoldPort(() => undefined);
    await expect(
      port.placeRiskAlertHold({ ...input, actorPermissions: ["payout-review-holds.manage"] }, operatorContext),
    ).rejects.toThrow("Settlement services are not composed on this host.");
  });
});

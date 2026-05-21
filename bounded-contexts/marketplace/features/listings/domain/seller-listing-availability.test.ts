import { describe, expect, it } from "vitest";
import {
  decideSellerListingAvailability,
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
} from "./seller-listing-availability";

describe("seller listing availability", () => {
  it("turns account listing availability off and back on without listing state", () => {
    const disabledEvents = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "audit",
      availableAgainOn: "2026-06-01",
      disabledAt: "2026-05-13T12:00:00.000Z",
    });
    const disabledState = disabledEvents.reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);
    const enabledEvents = decideSellerListingAvailability(disabledState, {
      type: "EnableSellerListingAvailability",
      accountId: "acc_seller",
      enabledAt: "2026-05-14T12:00:00.000Z",
    });
    const enabledState = enabledEvents.reduce(evolveSellerListingAvailability, disabledState);

    expect(disabledEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId: "acc_seller",
          reasonCategory: "audit",
          availableAgainOn: "2026-06-01",
          disabledAt: "2026-05-13T12:00:00.000Z",
        },
      },
    ]);
    expect(disabledState).toMatchObject({
      accountId: "acc_seller",
      status: "unavailable",
      disabledReasonCategory: "audit",
      availableAgainOn: "2026-06-01",
    });
    expect(enabledEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller",
          enabledAt: "2026-05-14T12:00:00.000Z",
        },
      },
    ]);
    expect(enabledState).toMatchObject({
      accountId: "acc_seller",
      status: "available",
      disabledReasonCategory: null,
      availableAgainOn: null,
    });
  });

  it("rejects invalid planned return dates", () => {
    expect(() =>
      decideSellerListingAvailability(initialSellerListingAvailabilityState, {
        type: "DisableSellerListingAvailability",
        accountId: "acc_seller",
        reasonCategory: null,
        availableAgainOn: "2026-99-99",
        disabledAt: "2026-05-13T12:00:00.000Z",
      }),
    ).toThrow("Available again date is invalid.");
  });
});

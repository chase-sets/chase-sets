import { describe, expect, it } from "vitest";
import {
  decideSellerListingAvailability,
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
  type SellerListingAvailabilityEvent,
} from "./seller-listing-availability";

describe("seller listing availability", () => {
  it("turns account listing availability off and back on without listing state", () => {
    const disabledEvents = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "audit",
      availableAgainOn: "2026-06-01",
      availableAgainAt: null,
      disabledAt: "2026-05-13T12:00:00.000Z",
    });
    const disabledState = disabledEvents.reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);
    const enabledEvents = decideSellerListingAvailability(disabledState, {
      type: "EnableSellerListingAvailability",
      accountId: "acc_seller",
      enabledAt: "2026-05-14T12:00:00.000Z",
      enabledBy: "seller",
    });
    const enabledState = enabledEvents.reduce(evolveSellerListingAvailability, disabledState);

    expect(disabledEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId: "acc_seller",
          reasonCategory: "audit",
          availableAgainOn: "2026-06-01",
          availableAgainAt: null,
          disabledAt: "2026-05-13T12:00:00.000Z",
        },
      },
    ]);
    expect(disabledState).toMatchObject({
      accountId: "acc_seller",
      status: "unavailable",
      disabledReasonCategory: "audit",
      availableAgainOn: "2026-06-01",
      availableAgainAt: null,
    });
    expect(enabledEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller",
          enabledAt: "2026-05-14T12:00:00.000Z",
          enabledBy: "seller",
        },
      },
    ]);
    expect(enabledState).toMatchObject({
      accountId: "acc_seller",
      status: "available",
      disabledReasonCategory: null,
      availableAgainOn: null,
      availableAgainAt: null,
      enabledBy: "seller",
    });
  });

  it("rejects invalid planned return dates", () => {
    expect(() =>
      decideSellerListingAvailability(initialSellerListingAvailabilityState, {
        type: "DisableSellerListingAvailability",
        accountId: "acc_seller",
        reasonCategory: null,
        availableAgainOn: "2026-99-99",
        availableAgainAt: null,
        disabledAt: "2026-05-13T12:00:00.000Z",
      }),
    ).toThrow("Available again date is invalid.");
  });

  it("accepts a future authoritative resume instant and derives the display date from it", () => {
    const events = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    });

    expect(events).toEqual([
      {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId: "acc_seller",
          reasonCategory: "travel",
          availableAgainOn: "2026-07-20",
          availableAgainAt: "2026-07-20T05:00:00.000Z",
          disabledAt: "2026-07-13T12:00:00.000Z",
        },
      },
    ]);
  });

  it("rejects a resume instant that is not after the disable time", () => {
    expect(() =>
      decideSellerListingAvailability(initialSellerListingAvailabilityState, {
        type: "DisableSellerListingAvailability",
        accountId: "acc_seller",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: "2026-07-13T11:00:00.000Z",
        disabledAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toThrow("Available again instant must be after the disable time.");
  });

  it("allows a null resume instant for an indefinite away period", () => {
    const events = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "other",
      availableAgainOn: null,
      availableAgainAt: null,
      disabledAt: "2026-07-13T12:00:00.000Z",
    });

    expect(events).toEqual([
      {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId: "acc_seller",
          reasonCategory: "other",
          availableAgainOn: null,
          availableAgainAt: null,
          disabledAt: "2026-07-13T12:00:00.000Z",
        },
      },
    ]);
  });

  it("emits an updated disabled fact when refreshing reason and return instant while already away", () => {
    const initialDisable = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    });
    const awayState = initialDisable.reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);

    const refreshEvents = decideSellerListingAvailability(awayState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "audit",
      availableAgainOn: null,
      availableAgainAt: "2026-08-01T05:00:00.000Z",
      disabledAt: "2026-07-15T09:00:00.000Z",
    });

    expect(refreshEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId: "acc_seller",
          reasonCategory: "audit",
          availableAgainOn: "2026-08-01",
          availableAgainAt: "2026-08-01T05:00:00.000Z",
          disabledAt: "2026-07-15T09:00:00.000Z",
        },
      },
    ]);
    const refreshedState = refreshEvents.reduce(evolveSellerListingAvailability, awayState);
    expect(refreshedState).toMatchObject({
      status: "unavailable",
      disabledReasonCategory: "audit",
      availableAgainAt: "2026-08-01T05:00:00.000Z",
    });
  });

  it("no-ops a disable command while away when every field is unchanged (idempotent double-submit)", () => {
    const initialDisable = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    });
    const awayState = initialDisable.reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);

    const repeatEvents = decideSellerListingAvailability(awayState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-15T09:00:00.000Z",
    });

    expect(repeatEvents).toEqual([]);
  });

  it("records scheduled enable provenance distinctly from a seller-initiated enable", () => {
    const disabled = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    }).reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);

    const scheduledEnableEvents = decideSellerListingAvailability(disabled, {
      type: "EnableSellerListingAvailability",
      accountId: "acc_seller",
      enabledAt: "2026-07-20T05:00:00.000Z",
      enabledBy: "scheduled",
    });

    expect(scheduledEnableEvents).toEqual([
      {
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller",
          enabledAt: "2026-07-20T05:00:00.000Z",
          enabledBy: "scheduled",
        },
      },
    ]);
    const scheduledState = scheduledEnableEvents.reduce(evolveSellerListingAvailability, disabled);
    expect(scheduledState.enabledBy).toBe("scheduled");
  });

  it("enables on a scheduled sweep when the observed dueBy still matches the live resume instant", () => {
    const disabled = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    }).reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);

    const events = decideSellerListingAvailability(disabled, {
      type: "EnableSellerListingAvailability",
      accountId: "acc_seller",
      enabledAt: "2026-07-20T06:00:00.000Z",
      enabledBy: "scheduled",
      dueBy: "2026-07-20T05:00:00.000Z",
    });

    expect(events).toEqual([
      {
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId: "acc_seller",
          enabledAt: "2026-07-20T06:00:00.000Z",
          enabledBy: "scheduled",
        },
      },
    ]);
  });

  it("no-ops a scheduled sweep enable when the seller pushed the resume instant forward after the sweep's read (lost race)", () => {
    const disabled = decideSellerListingAvailability(initialSellerListingAvailabilityState, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-07-20T05:00:00.000Z",
      disabledAt: "2026-07-13T12:00:00.000Z",
    }).reduce(evolveSellerListingAvailability, initialSellerListingAvailabilityState);

    // The seller extends their away period between the sweep's due-query and
    // the sweep's command reaching the aggregate.
    const extended = decideSellerListingAvailability(disabled, {
      type: "DisableSellerListingAvailability",
      accountId: "acc_seller",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: "2026-08-01T05:00:00.000Z",
      disabledAt: "2026-07-19T09:00:00.000Z",
    }).reduce(evolveSellerListingAvailability, disabled);

    const events = decideSellerListingAvailability(extended, {
      type: "EnableSellerListingAvailability",
      accountId: "acc_seller",
      enabledAt: "2026-07-20T06:00:00.000Z",
      enabledBy: "scheduled",
      dueBy: "2026-07-20T05:00:00.000Z",
    });

    expect(events).toEqual([]);
    expect(extended).toMatchObject({ status: "unavailable", availableAgainAt: "2026-08-01T05:00:00.000Z" });
  });

  it("reads legacy disabled events with only availableAgainOn as informational, never populating availableAgainAt", () => {
    const legacyDisabledEvent = {
      type: "marketplace.seller-listing-availability.disabled",
      data: {
        accountId: "acc_seller",
        reasonCategory: "audit",
        availableAgainOn: "2026-06-01",
        disabledAt: "2026-05-13T12:00:00.000Z",
        // No `availableAgainAt` key at all -- this is what a pre-migration
        // stored event payload looks like.
      },
    } as unknown as SellerListingAvailabilityEvent;

    const state = evolveSellerListingAvailability(initialSellerListingAvailabilityState, legacyDisabledEvent);

    expect(state).toMatchObject({
      status: "unavailable",
      availableAgainOn: "2026-06-01",
      availableAgainAt: null,
    });
  });

  it("reads legacy enabled events with no enabledBy as a seller action", () => {
    const legacyEnabledEvent = {
      type: "marketplace.seller-listing-availability.enabled",
      data: {
        accountId: "acc_seller",
        enabledAt: "2026-05-14T12:00:00.000Z",
        // No `enabledBy` key at all -- this is what a pre-migration stored
        // event payload looks like.
      },
    } as unknown as SellerListingAvailabilityEvent;

    const state = evolveSellerListingAvailability(initialSellerListingAvailabilityState, legacyEnabledEvent);

    expect(state).toMatchObject({
      status: "available",
      enabledBy: "seller",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  decideWaitlistSignup,
  evolveWaitlistSignup,
  initialWaitlistSignupState,
  type WaitlistSignupEvent,
  type WaitlistSignupRecordedEvent,
} from "./domain";

const source = {
  pagePath: "/",
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
};

function expectRecorded(event: WaitlistSignupEvent): WaitlistSignupRecordedEvent {
  if (event.type !== "public-presence.waitlist-signup.recorded") {
    throw new Error(`Expected a recorded event, got ${event.type}`);
  }
  return event;
}

describe("waitlist signup domain", () => {
  it("records a normalized signup with implied early-access consent", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: " TODD@EXAMPLE.COM ",
      role: "both",
      interests: ["pricing-tools", "low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0].data.email).toBe("todd@example.com");
    expect(events[0].data.interests).toEqual(["low-sales-fees", "pricing-tools"]);
    // Early-access consent is implied by signing up, so it is always granted
    // at the recorded timestamp regardless of any optional marketing opt-in.
    expect(events[0].data.emailConsentAcceptedAt).toBe("2026-05-07T12:00:00.000Z");
    expect(events[0].data.marketingConsentAcceptedAt).toBeNull();
  });

  it("records optional marketing consent when accepted", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: "2026-05-07T12:00:00.000Z",
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(events[0].data.marketingConsentAcceptedAt).toBe("2026-05-07T12:00:00.000Z");
  });

  it("updates an existing signup on duplicate email", async () => {
    const [recorded] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "buy",
      interests: ["set-completion"],
      marketingConsentAcceptedAt: null,
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });
    const state = evolveWaitlistSignup(initialWaitlistSignupState, recorded);
    const [updated] = await decideWaitlistSignup(state, {
      type: "RecordWaitlistSignup",
      email: "TODD@example.com",
      role: "both",
      interests: ["bulk-listing"],
      marketingConsentAcceptedAt: "2026-05-07T12:05:00.000Z",
      source,
      recordedAt: "2026-05-07T12:05:00.000Z",
    });

    expect(updated.type).toBe("public-presence.waitlist-signup.updated");
    expect(updated.data.signupId).toBe(recorded.data.signupId);
    expect(updated.data.role).toBe("both");
    expect(updated.data.marketingConsentAcceptedAt).toBe("2026-05-07T12:05:00.000Z");
  });

  it("requires a valid email", async () => {
    await expect(async () =>
      decideWaitlistSignup(initialWaitlistSignupState, {
        type: "RecordWaitlistSignup",
        email: "not-an-email",
        role: "both",
        interests: ["bulk-listing"],
        marketingConsentAcceptedAt: null,
        source,
        recordedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).rejects.toThrow("Enter a valid email address.");
  });

  it("requires a valid timestamp for optional marketing consent", async () => {
    await expect(async () =>
      decideWaitlistSignup(initialWaitlistSignupState, {
        type: "RecordWaitlistSignup",
        email: "todd@example.com",
        role: "both",
        interests: ["bulk-listing"],
        marketingConsentAcceptedAt: "not-a-timestamp",
        source,
        recordedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).rejects.toThrow("Marketing consent must record a timestamp.");
  });

  it("records referral attribution from a well-formed referral code", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "referred@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      referredBySignupId: "wls_abc123",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(expectRecorded(events[0]).data.referredBySignupId).toBe("wls_abc123");
  });

  it("ignores a malformed referral code", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "referred@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      referredBySignupId: "not-a-referral-code",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(expectRecorded(events[0]).data.referredBySignupId).toBeNull();
  });

  it("drops a self-referral", async () => {
    const [recorded] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "self@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const [selfReferred] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "self@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      referredBySignupId: recorded.data.signupId,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(expectRecorded(selfReferred).data.referredBySignupId).toBeNull();
  });

  it("does not carry referral attribution onto an update event", async () => {
    const [recorded] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "buy",
      interests: ["set-completion"],
      marketingConsentAcceptedAt: null,
      source,
      referredBySignupId: "wls_abc123",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });
    const state = evolveWaitlistSignup(initialWaitlistSignupState, recorded);
    expect(state.referredBySignupId).toBe("wls_abc123");

    const [updated] = await decideWaitlistSignup(state, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "both",
      interests: ["bulk-listing"],
      marketingConsentAcceptedAt: null,
      referredBySignupId: "wls_someoneElse",
      source,
      recordedAt: "2026-05-07T12:05:00.000Z",
    });

    expect(updated.type).toBe("public-presence.waitlist-signup.updated");
    expect("referredBySignupId" in updated.data).toBe(false);
    // The evolver preserves original attribution across updates because it
    // spreads existing state and the updated event never carries the field.
    const updatedState = evolveWaitlistSignup(state, updated);
    expect(updatedState.referredBySignupId).toBe("wls_abc123");
  });

  it("captures cohort quality signals for a sell-intent signup", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "seller@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon", "yu-gi-oh", "pokemon"],
      hasStoreLink: true,
      storeUrl: "https://example-store.com/shop",
      inventorySize: "500_to_2000",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const recorded = expectRecorded(events[0]);
    expect(recorded.data.cohortQuality.games).toEqual(["pokemon", "yu-gi-oh"]);
    expect(recorded.data.cohortQuality.hasStoreLink).toBe(true);
    expect(recorded.data.cohortQuality.storeUrl).toBe("https://example-store.com/shop");
    expect(recorded.data.cohortQuality.inventorySize).toBe("500_to_2000");
  });

  it("drops cohort quality signals for a buy-only signup even if sent", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "buyer@example.com",
      role: "buy",
      interests: ["set-completion"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon"],
      hasStoreLink: true,
      storeUrl: "https://example-store.com/shop",
      inventorySize: "2000_plus",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const recorded = expectRecorded(events[0]);
    expect(recorded.data.cohortQuality).toEqual({
      games: [],
      hasStoreLink: false,
      storeUrl: null,
      inventorySize: null,
    });
  });

  it("drops an unrecognized game and an unrecognized inventory-size bucket instead of rejecting the signup", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "seller2@example.com",
      role: "both",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon", "not-a-real-game"],
      hasStoreLink: false,
      inventorySize: "not-a-real-bucket",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const recorded = expectRecorded(events[0]);
    expect(recorded.data.cohortQuality.games).toEqual(["pokemon"]);
    expect(recorded.data.cohortQuality.inventorySize).toBeNull();
  });

  it("drops a store URL when hasStoreLink is false, even if one is sent", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "seller3@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon"],
      hasStoreLink: false,
      storeUrl: "https://example-store.com/shop",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const recorded = expectRecorded(events[0]);
    expect(recorded.data.cohortQuality.hasStoreLink).toBe(false);
    expect(recorded.data.cohortQuality.storeUrl).toBeNull();
  });

  it("drops a malformed store URL even when hasStoreLink is true", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "seller4@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon"],
      hasStoreLink: true,
      storeUrl: "not a url",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    const recorded = expectRecorded(events[0]);
    expect(recorded.data.cohortQuality.storeUrl).toBeNull();
  });

  it("refreshes cohort quality signals on an update event", async () => {
    const [recorded] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "sell",
      interests: ["low-sales-fees"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon"],
      hasStoreLink: false,
      inventorySize: "under_100",
      recordedAt: "2026-05-07T12:00:00.000Z",
    });
    const state = evolveWaitlistSignup(initialWaitlistSignupState, recorded);

    const [updated] = await decideWaitlistSignup(state, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "both",
      interests: ["bulk-listing"],
      marketingConsentAcceptedAt: null,
      source,
      games: ["pokemon", "magic-the-gathering"],
      hasStoreLink: true,
      storeUrl: "https://example-store.com",
      inventorySize: "2000_plus",
      recordedAt: "2026-05-07T12:05:00.000Z",
    });

    expect(updated.type).toBe("public-presence.waitlist-signup.updated");
    if (updated.type !== "public-presence.waitlist-signup.updated") {
      throw new Error("expected an updated event");
    }
    expect(updated.data.cohortQuality.games).toEqual(["magic-the-gathering", "pokemon"]);
    expect(updated.data.cohortQuality.hasStoreLink).toBe(true);
    expect(updated.data.cohortQuality.inventorySize).toBe("2000_plus");

    const updatedState = evolveWaitlistSignup(state, updated);
    expect(updatedState.cohortQuality.inventorySize).toBe("2000_plus");
  });
});

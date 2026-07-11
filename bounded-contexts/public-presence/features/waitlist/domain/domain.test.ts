import { describe, expect, it } from "vitest";
import { decideWaitlistSignup, evolveWaitlistSignup, initialWaitlistSignupState } from "./domain";

const source = {
  pagePath: "/",
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
};

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
});

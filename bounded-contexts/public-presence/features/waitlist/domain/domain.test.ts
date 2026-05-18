import { describe, expect, it } from "vitest";
import {
  decideWaitlistSignup,
  evolveWaitlistSignup,
  initialWaitlistSignupState,
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

describe("waitlist signup domain", () => {
  it("records a normalized signup with consent", async () => {
    const events = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: " TODD@EXAMPLE.COM ",
      role: "both",
      interests: ["pricing-tools", "low-sales-fees"],
      emailConsentAcceptedAt: "2026-05-07T12:00:00.000Z",
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0].data.email).toBe("todd@example.com");
    expect(events[0].data.interests).toEqual([
      "low-sales-fees",
      "pricing-tools",
    ]);
  });

  it("updates an existing signup on duplicate email", async () => {
    const [recorded] = await decideWaitlistSignup(initialWaitlistSignupState, {
      type: "RecordWaitlistSignup",
      email: "todd@example.com",
      role: "buy",
      interests: ["set-completion"],
      emailConsentAcceptedAt: "2026-05-07T12:00:00.000Z",
      source,
      recordedAt: "2026-05-07T12:00:00.000Z",
    });
    const state = evolveWaitlistSignup(initialWaitlistSignupState, recorded);
    const [updated] = await decideWaitlistSignup(state, {
      type: "RecordWaitlistSignup",
      email: "TODD@example.com",
      role: "both",
      interests: ["bulk-listing"],
      emailConsentAcceptedAt: "2026-05-07T12:05:00.000Z",
      source,
      recordedAt: "2026-05-07T12:05:00.000Z",
    });

    expect(updated.type).toBe("public-presence.waitlist-signup.updated");
    expect(updated.data.signupId).toBe(recorded.data.signupId);
    expect(updated.data.role).toBe("both");
  });

  it("requires consent and a valid email", async () => {
    await expect(async () =>
      decideWaitlistSignup(initialWaitlistSignupState, {
        type: "RecordWaitlistSignup",
        email: "not-an-email",
        role: "both",
        interests: ["bulk-listing"],
        emailConsentAcceptedAt: null,
        source,
        recordedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).rejects.toThrow("Enter a valid email address.");

    await expect(async () =>
      decideWaitlistSignup(initialWaitlistSignupState, {
        type: "RecordWaitlistSignup",
        email: "todd@example.com",
        role: "both",
        interests: ["bulk-listing"],
        emailConsentAcceptedAt: null,
        source,
        recordedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).rejects.toThrow("Email consent is required.");
  });
});

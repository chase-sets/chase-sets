import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it } from "vitest";
import {
  mapFoundersWindowOpenedToAdmissionEmail,
  mapWaitlistSignupRecordedToNurtureEmails,
} from "./transactional-email-intents";

describe("waitlist nurture email intents", () => {
  it("schedules the four signup-age touches from the recorded fact", () => {
    const deliveries = mapWaitlistSignupRecordedToNurtureEmails({
      email: "collector@example.com",
      signupId: "wls_collector",
      recordedAt: "2026-07-12T12:00:00.000Z",
      correlationId: "req_123",
    });

    expect(deliveries.map(({ step, availableAt }) => ({ step, availableAt }))).toEqual([
      { step: "welcome", availableAt: "2026-07-12T12:00:00.000Z" },
      { step: "fee-lock", availableAt: "2026-07-15T12:00:00.000Z" },
      { step: "open-offers", availableAt: "2026-07-19T12:00:00.000Z" },
      { step: "wave-approaching", availableAt: "2026-07-26T12:00:00.000Z" },
    ]);
    expect(deliveries.map(({ message }) => message.idempotencyKey)).toEqual([
      "public-presence:waitlist-nurture:wls_collector:welcome",
      "public-presence:waitlist-nurture:wls_collector:fee-lock",
      "public-presence:waitlist-nurture:wls_collector:open-offers",
      "public-presence:waitlist-nurture:wls_collector:wave-approaching",
    ]);
    for (const { message } of deliveries) {
      expect(message.category).toBe("operational");
      expect(message.criticality).toBe("operational");
      expect(message.templateData.referralLink).toContain("utm_medium=waitlist_email");
      expect(message.templateData.referralLink).toContain(`utm_content=${message.messageType.split(".").at(-1)}`);
    }
    const welcome = deliveries[0]!.message;
    expect(welcome.templateData.foundersTermsLink).toContain("/founders?utm_source=waitlist_email&utm_medium=email");
    expect(welcome.templateData.discordInviteLink).toContain("/welcome?signup=wls_collector&utm_source=waitlist_email");
  });

  it("keeps unshipped demo and market-data claims truth-gated", () => {
    const deliveries = mapWaitlistSignupRecordedToNurtureEmails({
      email: "collector@example.com",
      signupId: "wls_collector",
      recordedAt: "2026-07-12T12:00:00.000Z",
      correlationId: "req_123",
    });
    const openOffers = deliveries.find(({ step }) => step === "open-offers")!.message;
    const approaching = deliveries.find(({ step }) => step === "wave-approaching")!.message;

    expect(openOffers.templateData.intro).toContain("demo is still in production");
    expect(approaching.templateData.intro).toContain("not a shipped promise");
    expect(JSON.stringify(deliveries)).not.toContain("founders locked in");
  });

  it("uses missing cohort fields as the admission email's one ask", () => {
    const message = mapFoundersWindowOpenedToAdmissionEmail({
      email: "seller@example.com",
      signupId: "wls_seller",
      accountId: "acc_seller" as AccountId,
      betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
      foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
      missingCohortFields: ["the games you sell", "your inventory-size range"],
      correlationId: "req_admit",
    });

    expect(message.recipientAccountId).toBe("acc_seller");
    expect(message.category).toBe("operational");
    expect(message.templateData.missingAsk).toBe(
      "One quick ask before you start: add the games you sell and your inventory-size range so we can finish your wave-placement profile.",
    );
    expect(message.templateData.detailsLink).toContain("/welcome?signup=wls_seller&utm_source=waitlist_email");
    expect(message.templateData.preferencesLink).toContain("/?notifications=settings&utm_source=waitlist_email");
    expect(message.idempotencyKey).toBe(
      "public-presence:waitlist-nurture:wls_seller:wave-admitted:2026-07-31T12:00:00.000Z",
    );
  });

  it("links a complete admission profile to the real first-listing route", () => {
    const message = mapFoundersWindowOpenedToAdmissionEmail({
      email: "collector@example.com",
      signupId: "wls_collector",
      accountId: "acc_collector" as AccountId,
      betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
      foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
      missingCohortFields: [],
      correlationId: "req_admit",
    });

    expect(message.templateData.detailsLink).toContain(
      "https://marketplace.chasesets.com/account/sell-list?utm_source=waitlist_email",
    );
  });
});

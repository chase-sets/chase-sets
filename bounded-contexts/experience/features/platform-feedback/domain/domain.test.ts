import { describe, expect, it } from "vitest";
import {
  decidePlatformFeedback,
  evolvePlatformFeedback,
  initialPlatformFeedbackState,
} from "./domain";

describe("platform feedback domain", () => {
  it("submits valid platform feedback", async () => {
    const events = await Promise.resolve(decidePlatformFeedback(initialPlatformFeedbackState, {
      type: "SubmitPlatformFeedback",
      feedbackId: "pfb_test",
      userId: "usr_test",
      accountId: "acc_test",
      rating: 4,
      topic: "ease-of-use",
      comment: "Smooth flow.",
      followUpConsent: true,
      workflow: "checkout-payment",
      sourceRoutePath: "/account/payments/pay_test",
      relatedEntities: [{ type: "payment", id: "pay_test" }],
      submittedAt: "2026-05-07T12:00:00.000Z",
    }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("experience.platform-feedback.submitted");
    const submitted = events[0];
    if (submitted?.type !== "experience.platform-feedback.submitted") {
      throw new Error("Expected submitted event.");
    }
    expect(submitted.data.relatedEntityKey).toBe("payment:pay_test");
  });

  it("rejects invalid ratings and long comments", () => {
    expect(() =>
      decidePlatformFeedback(initialPlatformFeedbackState, {
        type: "SubmitPlatformFeedback",
        feedbackId: "pfb_test",
        userId: "usr_test",
        accountId: "acc_test",
        rating: 6,
        topic: "ease-of-use",
        comment: null,
        followUpConsent: false,
        workflow: "checkout-payment",
        sourceRoutePath: "/account/payments/pay_test",
        submittedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).toThrow("Rating must be between 1 and 5.");

    expect(() =>
      decidePlatformFeedback(initialPlatformFeedbackState, {
        type: "SubmitPlatformFeedback",
        feedbackId: "pfb_test",
        userId: "usr_test",
        accountId: "acc_test",
        rating: 5,
        topic: "ease-of-use",
        comment: "x".repeat(1001),
        followUpConsent: false,
        workflow: "checkout-payment",
        sourceRoutePath: "/account/payments/pay_test",
        submittedAt: "2026-05-07T12:00:00.000Z",
      }),
    ).toThrow("Comment must be 1000 characters or fewer.");
  });

  it("allows reviewed and archived admin lifecycle", async () => {
    const [submitted] = await Promise.resolve(decidePlatformFeedback(initialPlatformFeedbackState, {
      type: "SubmitPlatformFeedback",
      feedbackId: "pfb_test",
      userId: "usr_test",
      accountId: "acc_test",
      rating: 5,
      topic: "performance-reliability",
      followUpConsent: false,
      workflow: "inventory-create",
      sourceRoutePath: "/account/inventory",
      submittedAt: "2026-05-07T12:00:00.000Z",
    }));
    const state = evolvePlatformFeedback(initialPlatformFeedbackState, submitted!);
    const [reviewed] = await Promise.resolve(decidePlatformFeedback(state, {
      type: "MarkPlatformFeedbackReviewed",
      reviewedByUserId: "usr_admin",
      reviewedAt: "2026-05-07T13:00:00.000Z",
    }));
    const reviewedState = evolvePlatformFeedback(state, reviewed!);

    expect(reviewedState.status).toBe("reviewed");
    const archivedEvents = await Promise.resolve(
      decidePlatformFeedback(reviewedState, {
          type: "ArchivePlatformFeedback",
          archivedByUserId: "usr_admin",
          archivedAt: "2026-05-07T14:00:00.000Z",
        }),
    );
    expect(
      archivedEvents[0]?.type,
    ).toBe("experience.platform-feedback.archived");
  });
});

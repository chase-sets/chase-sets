import { describe, expect, it } from "vitest";
import {
  decidePlatformFeedback,
  evolvePlatformFeedback,
  initialPlatformFeedbackState,
  type SubmitPlatformFeedbackCommand,
} from "./domain";

const submitCommand = {
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
} satisfies SubmitPlatformFeedbackCommand;

describe("platform feedback domain", () => {
  it("submits valid platform feedback", () => {
    const events = decidePlatformFeedback(initialPlatformFeedbackState, submitCommand);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("experience.platform-feedback.submitted");
    const submitted = events[0];
    if (submitted?.type !== "experience.platform-feedback.submitted") {
      throw new Error("Expected submitted event.");
    }
    expect(submitted.data.relatedEntityKey).toBe("payment:pay_test");
  });

  it("keeps user submissions immutable after the first submit", () => {
    const [submitted] = decidePlatformFeedback(initialPlatformFeedbackState, submitCommand);
    const state = evolvePlatformFeedback(initialPlatformFeedbackState, submitted!);

    expect(() =>
      decidePlatformFeedback(state, {
        ...submitCommand,
        feedbackId: "pfb_second",
      }),
    ).toThrow("Platform feedback has already been submitted.");
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

  it("records prompt dismissal snooze windows", () => {
    const [dismissed] = decidePlatformFeedback(initialPlatformFeedbackState, {
      type: "DismissPlatformFeedbackPrompt",
      promptId: "pfp_test",
      userId: "usr_test",
      accountId: "acc_test",
      workflow: "inventory-adjust",
      sourceRoutePath: "/account/inventory/inv_test",
      relatedEntities: [{ type: "inventoryItem", id: "inv_test" }],
      dismissedAt: "2026-05-07T12:00:00.000Z",
      snoozedUntil: "2026-05-14T12:00:00.000Z",
    });

    expect(dismissed?.type).toBe("experience.platform-feedback.prompt-dismissed");
    const state = evolvePlatformFeedback(initialPlatformFeedbackState, dismissed!);
    expect(state.dismissedAt).toBe("2026-05-07T12:00:00.000Z");
    expect(state.relatedEntityKey).toBe("inventoryItem:inv_test");
  });

  it("allows reviewed and archived admin lifecycle", () => {
    const [submitted] = decidePlatformFeedback(initialPlatformFeedbackState, {
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
    });
    const state = evolvePlatformFeedback(initialPlatformFeedbackState, submitted!);
    const [reviewed] = decidePlatformFeedback(state, {
      type: "MarkPlatformFeedbackReviewed",
      reviewedByUserId: "usr_admin",
      reviewedAt: "2026-05-07T13:00:00.000Z",
    });
    const reviewedState = evolvePlatformFeedback(state, reviewed!);

    expect(reviewedState.status).toBe("reviewed");
    const archivedEvents = decidePlatformFeedback(reviewedState, {
      type: "ArchivePlatformFeedback",
      archivedByUserId: "usr_admin",
      archivedAt: "2026-05-07T14:00:00.000Z",
    });
    expect(archivedEvents[0]?.type).toBe("experience.platform-feedback.archived");
  });

  it("makes reviewed and archived admin transitions idempotent", () => {
    const [submitted] = decidePlatformFeedback(initialPlatformFeedbackState, submitCommand);
    const submittedState = evolvePlatformFeedback(initialPlatformFeedbackState, submitted!);
    const [reviewed] = decidePlatformFeedback(submittedState, {
      type: "MarkPlatformFeedbackReviewed",
      reviewedByUserId: "usr_admin",
      reviewedAt: "2026-05-07T13:00:00.000Z",
    });
    const reviewedState = evolvePlatformFeedback(submittedState, reviewed!);

    expect(
      decidePlatformFeedback(reviewedState, {
        type: "MarkPlatformFeedbackReviewed",
        reviewedByUserId: "usr_admin",
        reviewedAt: "2026-05-07T13:10:00.000Z",
      }),
    ).toEqual([]);

    const [archived] = decidePlatformFeedback(reviewedState, {
      type: "ArchivePlatformFeedback",
      archivedByUserId: "usr_admin",
      archivedAt: "2026-05-07T14:00:00.000Z",
    });
    const archivedState = evolvePlatformFeedback(reviewedState, archived!);

    expect(
      decidePlatformFeedback(archivedState, {
        type: "ArchivePlatformFeedback",
        archivedByUserId: "usr_admin",
        archivedAt: "2026-05-07T14:10:00.000Z",
      }),
    ).toEqual([]);
    expect(() =>
      decidePlatformFeedback(archivedState, {
        type: "MarkPlatformFeedbackReviewed",
        reviewedByUserId: "usr_admin",
        reviewedAt: "2026-05-07T14:20:00.000Z",
      }),
    ).toThrow("Archived platform feedback cannot be reviewed.");
  });
});

import { describe, expect, it } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  mapReviewOpportunityToNotification,
  mapReviewReminderToNotification,
  mapReviewRevealedToNotification,
} from "./notification-intents";

describe("review nudge notification intents (m108, #4270)", () => {
  it("gives a buyer author email + web channels and a seller author web-only", () => {
    const buyerMessage = mapReviewOpportunityToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_buyer" as AccountId,
      authorRole: "buyer",
      subjectDisplayName: "Card Shop",
      buyerEmail: "buyer@example.com",
      armedAt: "2026-04-03T00:00:00.000Z",
      correlationId: "corr_1",
    });
    expect(buyerMessage.channels.map((channel) => channel.channel)).toEqual(["email", "web"]);
    expect(buyerMessage.messageType).toBe("marketplace.review.opportunity");

    const sellerMessage = mapReviewOpportunityToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_seller" as AccountId,
      authorRole: "seller",
      subjectDisplayName: "Jane Buyer",
      buyerEmail: "buyer@example.com",
      armedAt: "2026-04-03T00:00:00.000Z",
      correlationId: "corr_2",
    });
    expect(sellerMessage.channels.map((channel) => channel.channel)).toEqual(["web"]);
  });

  it("keys the opportunity notification's idempotency to (order, author, armedAt) so a re-arm gets a fresh key", () => {
    const first = mapReviewOpportunityToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_buyer" as AccountId,
      authorRole: "buyer",
      subjectDisplayName: null,
      armedAt: "2026-04-03T00:00:00.000Z",
      correlationId: "corr_1",
    });
    const rearmed = mapReviewOpportunityToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_buyer" as AccountId,
      authorRole: "buyer",
      subjectDisplayName: null,
      armedAt: "2026-04-06T00:00:00.000Z",
      correlationId: "corr_2",
    });
    expect(first.idempotencyKey).not.toBe(rearmed.idempotencyKey);

    const replay = mapReviewOpportunityToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_buyer" as AccountId,
      authorRole: "buyer",
      subjectDisplayName: null,
      armedAt: "2026-04-03T00:00:00.000Z",
      correlationId: "corr_3",
    });
    expect(first.idempotencyKey).toBe(replay.idempotencyKey);
  });

  it("keys the reminder notification's idempotency to (order, author, eligibleAt)", () => {
    const message = mapReviewReminderToNotification({
      orderId: "ord_1",
      authorAccountId: "acc_buyer" as AccountId,
      authorRole: "buyer",
      subjectDisplayName: null,
      buyerEmail: "buyer@example.com",
      eligibleAt: "2026-04-03T00:00:00.000Z",
      correlationId: "corr_1",
    });
    expect(message.messageType).toBe("marketplace.review.opportunity-reminder");
    expect(message.idempotencyKey).toContain("ord_1");
    expect(message.idempotencyKey).toContain("2026-04-03T00:00:00.000Z");
  });

  it("routes the revealed notice to the review's subject with a per-review idempotency key", () => {
    const message = mapReviewRevealedToNotification({
      reviewId: "rev_1",
      orderId: "ord_1",
      subjectAccountId: "acc_buyer" as AccountId,
      subjectRole: "buyer",
      authorDisplayName: "Card Shop",
      buyerEmail: "buyer@example.com",
      correlationId: "corr_1",
    });
    expect(message.actor.accountId).toBe("acc_buyer");
    expect(message.messageType).toBe("marketplace.review.revealed");
    expect(message.idempotencyKey).toBe("notifications:marketplace:review_revealed:rev_1");
    expect(message.channels.map((channel) => channel.channel)).toEqual(["email", "web"]);
  });
});

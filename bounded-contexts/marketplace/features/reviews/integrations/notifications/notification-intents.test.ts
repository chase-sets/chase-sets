import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { resolveWebHostRouteRecords } from "@chase-sets/platform-runtime/web";
import type { WebNotificationChannel } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { contextManifest as marketplaceManifest } from "../../../../index";
import {
  mapReviewOpportunityToNotification,
  mapReviewReminderToNotification,
  mapReviewRevealedToNotification,
  type ReviewOpportunityNotificationInput,
  type ReviewReminderNotificationInput,
} from "./notification-intents";

const reviewRoutes = resolveWebHostRouteRecords(
  [
    {
      contextName: "marketplace",
      packageName: "@chase-sets/marketplace",
      manifest: marketplaceManifest as Parameters<typeof resolveWebHostRouteRecords>[0][number]["manifest"],
    },
  ],
  "marketplace-web",
).map((route) => ({ id: `marketplace/${route.routeId}`, path: route.routePath }));

const producers = [
  {
    kind: "opportunity",
    map: mapReviewOpportunityToNotification,
    messageType: "marketplace.review.opportunity",
    templateId: "review_opportunity",
    title: "You can now review order ord_1",
    body: (subject: string) => `Your order is delivered -- leave a review for ${subject}.`,
  },
  {
    kind: "reminder",
    map: mapReviewReminderToNotification,
    messageType: "marketplace.review.opportunity-reminder",
    templateId: "review_opportunity_reminder",
    title: "Reminder: review order ord_1",
    body: (subject: string) => `You still have time to leave a review for ${subject}.`,
  },
] as const;

const roleCases = producers.flatMap((producer) =>
  (["buyer", "seller"] as const).map((role) => ({ ...producer, role })),
);

function reviewInput(
  authorRole: ReviewOpportunityNotificationInput["authorRole"],
  buyerEmail?: string | null,
  subjectDisplayName: string | null = null,
): ReviewOpportunityNotificationInput & ReviewReminderNotificationInput {
  return {
    orderId: "ord_1",
    authorAccountId: "acc_author" as AccountId,
    authorRole,
    subjectDisplayName,
    buyerEmail,
    armedAt: "2026-04-03T00:00:00.000Z",
    eligibleAt: "2026-04-04T00:00:00.000Z",
    correlationId: "corr_1",
  };
}

describe("review nudge notification intents (m108, #4270)", () => {
  it.each(roleCases)("review-opportunity-role-route-resolution ($kind/$role)", ({ map, role }) => {
    const input = reviewInput(role, "buyer@example.com");
    const message = map(input);
    const expectedHref = `/account/${role === "buyer" ? "purchases" : "sales"}/${input.orderId}/review`;
    const expectedRouteId = `marketplace/${role === "buyer" ? "account-purchase-review" : "account-sale-review"}`;
    const expectedParams = role === "buyer" ? { purchaseId: input.orderId } : { orderId: input.orderId };
    const webChannels = message.channels.filter(
      (channel): channel is WebNotificationChannel => channel.channel === "web",
    );
    expect(webChannels).toHaveLength(1);

    for (const href of [message.actionHref, message.templateData.actionHref, ...webChannels.map((c) => c.actionHref)]) {
      const matches = matchRoutes(reviewRoutes, String(href));
      expect(matches, `route resolution for ${String(href)}`).toHaveLength(1);
      expect(matches?.[0]?.route.id).toBe(expectedRouteId);
      expect(matches?.[0]?.params).toEqual(expectedParams);
      expect(href).toBe(expectedHref);
    }
  });

  it.each(roleCases)("review-opportunity-notification-envelope-preserved ($kind/$role)", (producer) => {
    for (const buyerEmail of ["  buyer@example.com  ", undefined, null, "   "]) {
      for (const subjectDisplayName of ["Counterparty", null]) {
        const input = reviewInput(producer.role, buyerEmail, subjectDisplayName);
        const message = producer.map(input);
        const subject = subjectDisplayName ?? (producer.role === "buyer" ? "the seller" : "the buyer");
        const webChannel = {
          channel: "web",
          recipient: { accountId: input.authorAccountId },
          actionHref: expect.any(String),
        };
        expect(message).toEqual({
          messageType: producer.messageType,
          criticality: "operational",
          title: producer.title,
          body: producer.body(subject),
          actionHref: expect.any(String),
          templateId: producer.templateId,
          templateVersion: 1,
          locale: "en",
          templateData: {
            orderId: input.orderId,
            orderReference: input.orderId,
            authorRole: input.authorRole,
            actionHref: expect.any(String),
          },
          channels:
            producer.role === "buyer" && buyerEmail?.trim()
              ? [{ channel: "email", to: [{ email: "buyer@example.com" }] }, webChannel]
              : [webChannel],
          idempotencyKey: `notifications:marketplace:${producer.templateId}:${input.orderId}:${input.authorAccountId}:${
            producer.kind === "opportunity" ? input.armedAt : input.eligibleAt
          }`,
          correlationId: input.correlationId,
          actor: { userId: null, accountId: input.authorAccountId },
        });
        for (const href of [
          message.actionHref,
          message.templateData.actionHref,
          ...message.channels.filter((c): c is WebNotificationChannel => c.channel === "web").map((c) => c.actionHref),
        ]) {
          expect(href).not.toContain("/account/reviews/opportunities/");
        }
      }
    }
  });

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

  it.each(["buyer", "seller"] as const)("preserves the revealed-review envelope (%s)", (subjectRole) => {
    const message = mapReviewRevealedToNotification({
      reviewId: "rev_1",
      orderId: "ord_1",
      subjectAccountId: "acc_subject" as AccountId,
      subjectRole,
      authorDisplayName: "Counterparty",
      buyerEmail: "buyer@example.com",
      correlationId: "corr_revealed",
    });
    const actionHref = "/account/reviews/rev_1";
    const webChannel = { channel: "web", recipient: { accountId: "acc_subject" }, actionHref };
    expect(message).toEqual({
      messageType: "marketplace.review.revealed",
      criticality: "operational",
      title: "A review on order ord_1 is now visible",
      body: "Counterparty left you a review. You can now view it and respond.",
      actionHref,
      templateId: "review_revealed",
      templateVersion: 1,
      locale: "en",
      templateData: { reviewId: "rev_1", orderId: "ord_1", orderReference: "ord_1", actionHref },
      channels:
        subjectRole === "buyer"
          ? [{ channel: "email", to: [{ email: "buyer@example.com" }] }, webChannel]
          : [webChannel],
      idempotencyKey: "notifications:marketplace:review_revealed:rev_1",
      correlationId: "corr_revealed",
      actor: { userId: null, accountId: "acc_subject" },
    });
  });
});

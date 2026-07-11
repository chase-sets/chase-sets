import { t } from "@chase-sets/localization";
import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/outbound-messaging";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { ReviewRole } from "../../domain/common";

function orderReferenceOrRaw(orderId: string): string {
  return deriveDisplayReferenceOrRaw(orderId as OrderId);
}

// Reviews has no per-account email anywhere in its source tables -- only the
// buyer's shipping email snapshot captured at order-create time. A buyer
// recipient gets web + email; a seller recipient stays web-only, mirroring
// every other seller-directed notification intent in the platform (see
// notifications/features/notification-center/integrations/source-events --
// `sellerWebNotification` never attaches an email channel either).
function recipientChannels(
  input: Readonly<{
    accountId: AccountId;
    actionHref: string;
    buyerEmail?: string | null;
  }>,
): NotificationMessage["channels"] {
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.accountId },
    actionHref: input.actionHref,
  };
  const email = input.buyerEmail?.trim();

  return email ? [{ channel: "email", to: [{ email }] } satisfies EmailNotificationChannel, webChannel] : [webChannel];
}

export type ReviewOpportunityNotificationInput = Readonly<{
  orderId: string;
  authorAccountId: AccountId;
  authorRole: ReviewRole;
  subjectDisplayName: string | null;
  buyerEmail?: string | null;
  // Distinguishes an initial grant from an eligibility restoration
  // ("re-armed" after a suspension) in the idempotency key so a restore is a
  // genuinely new notification rather than a no-op collapse into the
  // already-sent initial opportunity.
  armedAt: string;
  correlationId: string;
}>;

export function mapReviewOpportunityToNotification(input: ReviewOpportunityNotificationInput): NotificationMessage {
  const orderReference = orderReferenceOrRaw(input.orderId);
  const actionHref = `/account/reviews/opportunities/${input.orderId}`;
  const subjectLabel = input.subjectDisplayName ?? (input.authorRole === "buyer" ? "the seller" : "the buyer");

  return {
    messageType: "marketplace.review.opportunity",
    criticality: "operational",
    title: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewOpportunity.title", {
      orderReference,
    }),
    body: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewOpportunity.body", {
      subjectLabel,
    }),
    actionHref,
    templateId: "review_opportunity",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, orderReference, authorRole: input.authorRole, actionHref },
    channels: recipientChannels({
      accountId: input.authorAccountId,
      actionHref,
      buyerEmail: input.authorRole === "buyer" ? input.buyerEmail : null,
    }),
    idempotencyKey: `notifications:marketplace:review_opportunity:${input.orderId}:${input.authorAccountId}:${input.armedAt}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.authorAccountId },
  };
}

export type ReviewReminderNotificationInput = Readonly<{
  orderId: string;
  authorAccountId: AccountId;
  authorRole: ReviewRole;
  subjectDisplayName: string | null;
  buyerEmail?: string | null;
  eligibleAt: string;
  correlationId: string;
}>;

export function mapReviewReminderToNotification(input: ReviewReminderNotificationInput): NotificationMessage {
  const orderReference = orderReferenceOrRaw(input.orderId);
  const actionHref = `/account/reviews/opportunities/${input.orderId}`;
  const subjectLabel = input.subjectDisplayName ?? (input.authorRole === "buyer" ? "the seller" : "the buyer");

  return {
    messageType: "marketplace.review.opportunity-reminder",
    criticality: "operational",
    title: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewReminder.title", {
      orderReference,
    }),
    body: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewReminder.body", {
      subjectLabel,
    }),
    actionHref,
    templateId: "review_opportunity_reminder",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, orderReference, authorRole: input.authorRole, actionHref },
    channels: recipientChannels({
      accountId: input.authorAccountId,
      actionHref,
      buyerEmail: input.authorRole === "buyer" ? input.buyerEmail : null,
    }),
    idempotencyKey: `notifications:marketplace:review_opportunity_reminder:${input.orderId}:${input.authorAccountId}:${input.eligibleAt}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.authorAccountId },
  };
}

export type ReviewRevealedNotificationInput = Readonly<{
  reviewId: string;
  orderId: string;
  // The recipient is the review's SUBJECT: the account the review is about,
  // now able to see it (and, per m108's subject-reply feature, respond to
  // it) for the first time.
  subjectAccountId: AccountId;
  // The subject's own role in the underlying order -- the opposite of the
  // review's `authorRole` -- decides whether the subject is the buyer (email
  // available) or the seller (web-only).
  subjectRole: ReviewRole;
  authorDisplayName: string | null;
  buyerEmail?: string | null;
  correlationId: string;
}>;

export function mapReviewRevealedToNotification(input: ReviewRevealedNotificationInput): NotificationMessage {
  const orderReference = orderReferenceOrRaw(input.orderId);
  const actionHref = `/reviews/${input.reviewId}`;
  const authorLabel = input.authorDisplayName ?? (input.subjectRole === "buyer" ? "the seller" : "the buyer");

  return {
    messageType: "marketplace.review.revealed",
    criticality: "operational",
    title: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewRevealed.title", {
      orderReference,
    }),
    body: t("reputation.features.reviews.integrations.notifications.notificationIntents.reviewRevealed.body", {
      authorLabel,
    }),
    actionHref,
    templateId: "review_revealed",
    templateVersion: 1,
    locale: "en",
    templateData: { reviewId: input.reviewId, orderId: input.orderId, orderReference, actionHref },
    channels: recipientChannels({
      accountId: input.subjectAccountId,
      actionHref,
      buyerEmail: input.subjectRole === "buyer" ? input.buyerEmail : null,
    }),
    idempotencyKey: `notifications:marketplace:review_revealed:${input.reviewId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.subjectAccountId },
  };
}

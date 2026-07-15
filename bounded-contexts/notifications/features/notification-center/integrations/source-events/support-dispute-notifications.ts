import { t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId, OrderId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import type {
  NotificationCriticality,
  NotificationCategory,
  NotificationMessage,
  NotificationOutbox,
  WebNotificationChannel,
} from "@chase-sets/outbound-messaging";

/**
 * Dispute lifecycle notification matrix — both parties, in-app.
 *
 * Notifications subscribes to the support-request case lifecycle (owned by
 * Platform Operations) and the settlement support-hold lifecycle facts (owned
 * by Settlement) and turns each transition into an in-app Notification Center
 * feed item routed to the party who must act — or who is owed the outcome.
 *
 * Two rules govern the copy:
 *  - Every message names the recipient's next action, or says none is needed.
 *    No "something happened, log in to find out" bodies.
 *  - A support hold that was *consumed* by a refund never tells the seller their
 *    funds were "released back" to them — that is reserved for a *released* hold.
 *
 * Routing needs both the buyer and the seller account for a case, but only the
 * `opened` and `resolved` events (and the settlement facts) carry both parties.
 * Mid-lifecycle events carry only the support-request id, so this slice keeps a
 * tiny Notifications-owned routing directory (`notification_support_cases`),
 * populated from `opened`, and joins later events against it.
 */

// ---------------------------------------------------------------------------
// Case-routing directory (Notifications-owned read model)
// ---------------------------------------------------------------------------

export type SupportCaseRouting = Readonly<{
  supportRequestId: string;
  orderId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: string;
  sellerResponseDueAt: string | null;
}>;

export interface SupportCaseDirectory {
  recordOpenedCase(input: SupportCaseRouting & Readonly<{ streamVersion: number }>): Promise<void>;
  lookupCase(supportRequestId: string): Promise<SupportCaseRouting | null>;
}

/** In-memory directory for unit tests; production uses the Postgres adapter in services.ts. */
export function createInMemorySupportCaseDirectory(seed: readonly SupportCaseRouting[] = []): SupportCaseDirectory {
  const cases = new Map<string, SupportCaseRouting>(seed.map((entry) => [entry.supportRequestId, entry]));
  return {
    async recordOpenedCase(input) {
      const { streamVersion: _streamVersion, ...routing } = input;
      cases.set(input.supportRequestId, routing);
    },
    async lookupCase(supportRequestId) {
      return cases.get(supportRequestId) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Event catalog & notification matrix (completeness contract)
// ---------------------------------------------------------------------------

/** Every event the support-request aggregate publishes. The matrix must classify all of them. */
export const SUPPORT_REQUEST_LIFECYCLE_EVENT_TYPES = [
  "support.support-request.opened",
  "support.support-request.affected-line-items-recorded",
  "support.support-request.evidence-submitted",
  "support.support-request.response-recorded",
  "support.support-request.offer-accepted",
  "support.support-request.offer-declined",
  "support.support-request.escalated",
  "support.support-request.resolved",
  "support.support-request.closed",
  "support.support-request.cancelled",
  "support.support-request.response-reminder-emitted",
  "support.support-request.review-reminder-emitted",
  "support.support-request.return-delivered",
  "support.support-request.return-condition-disputed",
  "support.support-request.return-refund-released",
  "support.support-request.remedy-proposed",
  "support.support-request.remedy-approved",
  "support.support-request.remedy-authorized.v1",
  "support.support-request.remedy-effect-recorded",
  "support.support-request.remedy-effect-retry-requested",
  "support.support-request.remedy-effect-waived",
  "support.support-request.remedy-correction-requested",
  "support.support-request.remedy-completed.v1",
  "support.support-request.platform-coverage-requested.v1",
  "support.support-request.refund-released.v1",
] as const;

export type SupportRequestLifecycleEventType = (typeof SUPPORT_REQUEST_LIFECYCLE_EVENT_TYPES)[number];

/** The subset of lifecycle events that produce a party-facing notification. Kept in sync with the matrix by the completeness test. */
export const SUPPORT_DISPUTE_NOTIFYING_EVENT_TYPES = [
  "support.support-request.opened",
  "support.support-request.response-recorded",
  "support.support-request.offer-declined",
  "support.support-request.escalated",
  "support.support-request.resolved",
  "support.support-request.cancelled",
  "support.support-request.response-reminder-emitted",
  "support.support-request.return-delivered",
  "support.support-request.return-condition-disputed",
  "support.support-request.return-refund-released",
] as const satisfies readonly SupportRequestLifecycleEventType[];

/** The settlement-owned support-hold facts this slice also routes (all seller-facing). */
export const SETTLEMENT_SUPPORT_HOLD_FACT_TYPES = [
  "settlement.support-hold.placed.v1",
  "settlement.support-hold.released.v1",
  "settlement.support-hold.consumed.v1",
] as const;

export type SettlementSupportHoldFactType = (typeof SETTLEMENT_SUPPORT_HOLD_FACT_TYPES)[number];

/** Who a lifecycle transition notifies. `counterparty`/`acting-party`/`proposer` resolve per-event. */
export type SupportNotificationAudience = "buyer" | "seller" | "both" | "counterparty" | "acting-party" | "proposer";

export type SupportDisputeNotificationDecision =
  | Readonly<{ kind: "notify"; audience: SupportNotificationAudience; note: string }>
  | Readonly<{ kind: "internal"; reason: string }>;

/**
 * The dispute lifecycle matrix: every support-request event maps to either a
 * party-facing notification or an explicit internal (no-notify) decision with a
 * reason. The completeness test asserts this record covers the catalog exactly,
 * so a newly added lifecycle event cannot ship without a routing decision.
 */
export const SUPPORT_DISPUTE_NOTIFICATION_MATRIX: Record<
  SupportRequestLifecycleEventType,
  SupportDisputeNotificationDecision
> = {
  "support.support-request.opened": {
    kind: "notify",
    audience: "both",
    note: "Seller: action needed by the response deadline. Buyer: confirmation with the outcome preview.",
  },
  "support.support-request.response-recorded": {
    kind: "notify",
    audience: "counterparty",
    note: "The counterparty reviews the response or the offer that was recorded.",
  },
  "support.support-request.offer-declined": {
    kind: "notify",
    audience: "proposer",
    note: "The party who made the offer learns it was declined and the case continues.",
  },
  "support.support-request.escalated": {
    kind: "notify",
    audience: "both",
    note: "Both parties learn Chase Sets support is now reviewing; no action needed yet.",
  },
  "support.support-request.resolved": {
    kind: "notify",
    audience: "both",
    note: "Both parties get the outcome; adjudicated decisions are stated as binding.",
  },
  "support.support-request.cancelled": {
    kind: "notify",
    audience: "both",
    note: "Both parties learn the case was cancelled and no action remains.",
  },
  "support.support-request.response-reminder-emitted": {
    kind: "notify",
    audience: "acting-party",
    note: "The party whose response is due is reminded before the deadline.",
  },
  "support.support-request.return-delivered": {
    kind: "notify",
    audience: "seller",
    note: "The seller inspects the delivered return before the inspection window closes.",
  },
  "support.support-request.return-condition-disputed": {
    kind: "notify",
    audience: "buyer",
    note: "The buyer learns the seller disputed the return condition; support will review.",
  },
  "support.support-request.return-refund-released": {
    kind: "notify",
    audience: "buyer",
    note: "The buyer learns the return was accepted and the refund is on its way.",
  },
  "support.support-request.offer-accepted": {
    kind: "internal",
    reason: "Acceptance resolves the case; the resolved notification carries the outcome to both parties.",
  },
  "support.support-request.affected-line-items-recorded": {
    kind: "internal",
    reason: "Data enrichment on the case; surfaced on the case detail, not a standalone push.",
  },
  "support.support-request.evidence-submitted": {
    kind: "internal",
    reason: "Case-building detail shown on the case timeline; the response/escalation carries the action.",
  },
  "support.support-request.closed": {
    kind: "internal",
    reason: "Auto-close housekeeping after the resolved notification already delivered the outcome.",
  },
  "support.support-request.review-reminder-emitted": {
    kind: "internal",
    reason: "Operator-facing support-review nudge; buyer/seller have no action on the review clock.",
  },
  "support.support-request.remedy-proposed": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-approved": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-authorized.v1": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-effect-recorded": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-effect-retry-requested": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-effect-waived": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-correction-requested": {
    kind: "internal",
    reason: "Operator remedy execution audit; customer-facing remedy progress is its own surface.",
  },
  "support.support-request.remedy-completed.v1": {
    kind: "internal",
    reason: "Customer-facing remedy progress is exposed on the remedy-progress surface, not this feed.",
  },
  "support.support-request.platform-coverage-requested.v1": {
    kind: "internal",
    reason: "Settlement coverage request; no buyer/seller action, routed inside Settlement.",
  },
  "support.support-request.refund-released.v1": {
    kind: "internal",
    reason: "Money-released fact; the resolved and settlement-hold facts carry the customer-facing signal.",
  },
};

// ---------------------------------------------------------------------------
// Event payload shapes (structural — Notifications reads only what it routes on)
// ---------------------------------------------------------------------------

type SupportRole = "buyer" | "seller" | "support";

type SupportOpenedData = Readonly<{
  supportRequestId: string;
  orderId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: string;
  openedAt: string;
  sellerResponseDueAt: string | null;
}>;

type SupportResponseData = Readonly<{
  supportRequestId: string;
  response: Readonly<{ responseId: string; submittedByRole: SupportRole; offerId: string | null }>;
  offer: Readonly<{
    offerId: string;
    offeredByRole: SupportRole;
    pendingWithRole: SupportRole;
    resolutionType: string;
    refundAmount: string | null;
  }> | null;
}>;

type SupportOfferDeclinedData = Readonly<{
  supportRequestId: string;
  offer: Readonly<{ offerId: string; offeredByRole: SupportRole; resolutionType: string }>;
}>;

type SupportEscalatedData = Readonly<{
  supportRequestId: string;
  escalatedAt: string;
  reason: string;
}>;

type SupportResolvedData = Readonly<{
  supportRequestId: string;
  orderId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: string;
  resolution: Readonly<{
    resolutionType: string;
    resolvedAt: string;
    refundAmount: string | null;
    evidenceBasis: Readonly<{ type: string; reference: string }>;
  }>;
}>;

type SupportCancelledData = Readonly<{ supportRequestId: string; cancelledAt: string; reason: string }>;

type SupportResponseReminderData = Readonly<{
  supportRequestId: string;
  remindedAt: string;
  actingRole: SupportRole;
  dueAt: string;
}>;

type SupportReturnDeliveredData = Readonly<{
  supportRequestId: string;
  deliveredAt: string;
  returnRefundReleaseDueAt: string;
}>;

type SupportReturnConditionDisputedData = Readonly<{
  supportRequestId: string;
  disputedAt: string;
  reason: string;
}>;

type SupportReturnRefundReleasedData = Readonly<{ supportRequestId: string; releasedAt: string }>;

/**
 * Settlement support-hold lifecycle facts (the settlement-owned `SupportHoldNotice`
 * aggregate). Typed locally against the published contract until the settlement slice
 * lands its `contracts/event-core/public-event-payloads.ts` entries; the fields are the
 * support-safe routing envelope, no provider/ledger data.
 */
type SettlementSupportHoldFactData = Readonly<{
  holdId: string;
  supportRequestId: string;
  orderId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: string;
  occurredAt: string;
}>;

type SettlementSupportHoldReleasedData = SettlementSupportHoldFactData &
  Readonly<{ releaseReason: "support-resolved" | "support-closed" | "support-cancelled" }>;

type SettlementSupportHoldConsumedData = SettlementSupportHoldFactData & Readonly<{ resolutionType: string }>;

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

const CASE_LINK = (supportRequestId: string) => `/account/support/${supportRequestId}`;

function orderRef(orderId: string): string {
  return deriveDisplayReferenceOrRaw(orderId as OrderId);
}

function caseRef(supportRequestId: string): string {
  return deriveDisplayReferenceOrRaw(supportRequestId as SupportRequestId);
}

function deadlineLabel(deadline: string | null): string {
  return deadline ?? t("notifications.intents.supportDispute.noDeadline");
}

function counterpartyOf(role: SupportRole): SupportRole {
  if (role === "buyer") return "seller";
  if (role === "seller") return "buyer";
  return "support";
}

function accountForRole(routing: SupportCaseRouting, role: "buyer" | "seller"): AccountId {
  return role === "buyer" ? routing.buyerAccountId : routing.sellerAccountId;
}

function caseWebNotification(
  input: Readonly<{
    recipientAccountId: AccountId;
    messageType: string;
    criticality: NotificationCriticality;
    category: NotificationCategory;
    title: string;
    body: string;
    actionHref: string;
    templateId: string;
    templateData: NotificationMessage["templateData"];
    idempotencyKey: string;
    correlationId: string;
  }>,
): NotificationMessage {
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.recipientAccountId },
    actionHref: input.actionHref,
  };

  return {
    messageType: input.messageType as NotificationMessage["messageType"],
    criticality: input.criticality,
    category: input.category,
    recipientAccountId: input.recipientAccountId,
    title: input.title,
    body: input.body,
    actionHref: input.actionHref,
    templateId: input.templateId,
    templateVersion: 1,
    locale: "en",
    templateData: input.templateData,
    channels: [webChannel],
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.recipientAccountId },
  };
}

// ---------------------------------------------------------------------------
// Intent mappers (pure; one NotificationMessage per recipient)
// ---------------------------------------------------------------------------

export type SupportCaseOpenedNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  correlationId: string;
}>;

export function mapSupportCaseOpenedToSellerNotification(
  input: SupportCaseOpenedNotificationInput,
): NotificationMessage {
  const { routing } = input;
  return caseWebNotification({
    recipientAccountId: routing.sellerAccountId,
    messageType: "support.support-request.opened",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.openedSeller.title", { orderReference: orderRef(routing.orderId) }),
    body: t("notifications.intents.supportDispute.openedSeller.body", {
      deadline: deadlineLabel(routing.sellerResponseDueAt),
    }),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_opened_seller",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      flowType: routing.flowType,
      deadline: routing.sellerResponseDueAt,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:opened:${routing.supportRequestId}:${routing.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export function mapSupportCaseOpenedToBuyerNotification(
  input: SupportCaseOpenedNotificationInput,
): NotificationMessage {
  const { routing } = input;
  return caseWebNotification({
    recipientAccountId: routing.buyerAccountId,
    messageType: "support.support-request.opened",
    criticality: "operational",
    category: "operational",
    title: t("notifications.intents.supportDispute.openedBuyer.title", { orderReference: orderRef(routing.orderId) }),
    body: t("notifications.intents.supportDispute.openedBuyer.body"),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_opened_buyer",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      flowType: routing.flowType,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:opened:${routing.supportRequestId}:${routing.buyerAccountId}`,
    correlationId: input.correlationId,
  });
}

export type SupportResponseNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportResponseData;
  correlationId: string;
}>;

/** Response/offer recorded → the counterparty reviews it. Returns null when the acting side has no marketplace counterparty (support). */
export function mapSupportResponseRecordedToNotification(
  input: SupportResponseNotificationInput,
): NotificationMessage | null {
  const { routing, data } = input;
  const offer = data.offer;
  // An offer routes to whoever must respond to it; a plain response routes to the counterparty.
  const recipientRole: SupportRole = offer ? offer.pendingWithRole : counterpartyOf(data.response.submittedByRole);
  if (recipientRole === "support") {
    return null;
  }

  const title = offer
    ? t("notifications.intents.supportDispute.offerRecorded.title", { orderReference: orderRef(routing.orderId) })
    : t("notifications.intents.supportDispute.responseRecorded.title", { orderReference: orderRef(routing.orderId) });
  const body = offer
    ? t("notifications.intents.supportDispute.offerRecorded.body", {
        offeredBy: t(`notifications.intents.supportDispute.party.${offer.offeredByRole}`),
        resolution: t(`notifications.intents.supportDispute.resolution.${offer.resolutionType}`),
      })
    : t("notifications.intents.supportDispute.responseRecorded.body");

  const discriminator = offer ? `offer:${offer.offerId}` : `response:${data.response.responseId}`;
  return caseWebNotification({
    recipientAccountId: accountForRole(routing, recipientRole),
    messageType: "support.support-request.response-recorded",
    criticality: "commerce",
    category: "order-critical",
    title,
    body,
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: offer ? "support_dispute_offer_recorded" : "support_dispute_response_recorded",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      hasOffer: offer !== null,
      resolutionType: offer?.resolutionType ?? null,
      refundAmount: offer?.refundAmount ?? null,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:response:${routing.supportRequestId}:${discriminator}:${accountForRole(routing, recipientRole)}`,
    correlationId: input.correlationId,
  });
}

export type SupportOfferDeclinedNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportOfferDeclinedData;
  correlationId: string;
}>;

/** Offer declined → the party who proposed it learns the case continues. */
export function mapSupportOfferDeclinedToNotification(
  input: SupportOfferDeclinedNotificationInput,
): NotificationMessage | null {
  const { routing, data } = input;
  if (data.offer.offeredByRole === "support") {
    return null;
  }
  const recipientRole = data.offer.offeredByRole;
  return caseWebNotification({
    recipientAccountId: accountForRole(routing, recipientRole),
    messageType: "support.support-request.offer-declined",
    criticality: "operational",
    category: "operational",
    title: t("notifications.intents.supportDispute.offerDeclined.title", { orderReference: orderRef(routing.orderId) }),
    body: t("notifications.intents.supportDispute.offerDeclined.body"),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_offer_declined",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      resolutionType: data.offer.resolutionType,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:offer-declined:${routing.supportRequestId}:${data.offer.offerId}:${accountForRole(routing, recipientRole)}`,
    correlationId: input.correlationId,
  });
}

export type SupportEscalatedNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportEscalatedData;
  correlationId: string;
}>;

/** Escalated → both parties, no action needed while support reviews. */
export function mapSupportEscalatedToNotifications(
  input: SupportEscalatedNotificationInput,
): readonly NotificationMessage[] {
  const { routing, data } = input;
  const build = (recipientAccountId: AccountId): NotificationMessage =>
    caseWebNotification({
      recipientAccountId,
      messageType: "support.support-request.escalated",
      criticality: "operational",
      category: "operational",
      title: t("notifications.intents.supportDispute.escalated.title", { orderReference: orderRef(routing.orderId) }),
      body: t("notifications.intents.supportDispute.escalated.body"),
      actionHref: CASE_LINK(routing.supportRequestId),
      templateId: "support_dispute_escalated",
      templateData: {
        supportReference: caseRef(routing.supportRequestId),
        orderReference: orderRef(routing.orderId),
        actionHref: CASE_LINK(routing.supportRequestId),
      },
      idempotencyKey: `notifications:support:escalated:${routing.supportRequestId}:${data.escalatedAt}:${recipientAccountId}`,
      correlationId: input.correlationId,
    });
  return [build(routing.buyerAccountId), build(routing.sellerAccountId)];
}

export type SupportResolvedNotificationInput = Readonly<{
  data: SupportResolvedData;
  correlationId: string;
}>;

/** Resolved → both parties, stating the outcome; adjudicated decisions are binding. */
export function mapSupportResolvedToNotifications(
  input: SupportResolvedNotificationInput,
): readonly NotificationMessage[] {
  const { data } = input;
  const outcome = t(`notifications.intents.supportDispute.resolution.${data.resolution.resolutionType}`);
  const bindingKey = resolvedBodyKeyFor(data.resolution.evidenceBasis.type);
  const build = (recipientAccountId: AccountId): NotificationMessage =>
    caseWebNotification({
      recipientAccountId,
      messageType: "support.support-request.resolved",
      criticality: "commerce",
      category: "order-critical",
      title: t("notifications.intents.supportDispute.resolved.title", { orderReference: orderRef(data.orderId) }),
      body: t(bindingKey, { outcome }),
      actionHref: CASE_LINK(data.supportRequestId),
      templateId: "support_dispute_resolved",
      templateData: {
        supportReference: caseRef(data.supportRequestId),
        orderReference: orderRef(data.orderId),
        resolutionType: data.resolution.resolutionType,
        refundAmount: data.resolution.refundAmount,
        evidenceBasis: data.resolution.evidenceBasis.type,
        binding: data.resolution.evidenceBasis.type === "operator-finding",
        actionHref: CASE_LINK(data.supportRequestId),
      },
      idempotencyKey: `notifications:support:resolved:${data.supportRequestId}:${data.resolution.resolvedAt}:${recipientAccountId}`,
      correlationId: input.correlationId,
    });
  return [build(data.buyerAccountId), build(data.sellerAccountId)];
}

function resolvedBodyKeyFor(evidenceBasisType: string): string {
  if (evidenceBasisType === "operator-finding") {
    return "notifications.intents.supportDispute.resolved.body.adjudicated";
  }
  if (evidenceBasisType === "party-accepted-resolution") {
    return "notifications.intents.supportDispute.resolved.body.agreement";
  }
  if (evidenceBasisType === "deterministic-policy") {
    return "notifications.intents.supportDispute.resolved.body.automated";
  }
  return "notifications.intents.supportDispute.resolved.body.generic";
}

export type SupportCancelledNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportCancelledData;
  correlationId: string;
}>;

/** Cancelled → both parties learn the case is closed with nothing left to do. */
export function mapSupportCancelledToNotifications(
  input: SupportCancelledNotificationInput,
): readonly NotificationMessage[] {
  const { routing, data } = input;
  const build = (recipientAccountId: AccountId): NotificationMessage =>
    caseWebNotification({
      recipientAccountId,
      messageType: "support.support-request.cancelled",
      criticality: "operational",
      category: "operational",
      title: t("notifications.intents.supportDispute.cancelled.title", { orderReference: orderRef(routing.orderId) }),
      body: t("notifications.intents.supportDispute.cancelled.body"),
      actionHref: CASE_LINK(routing.supportRequestId),
      templateId: "support_dispute_cancelled",
      templateData: {
        supportReference: caseRef(routing.supportRequestId),
        orderReference: orderRef(routing.orderId),
        actionHref: CASE_LINK(routing.supportRequestId),
      },
      idempotencyKey: `notifications:support:cancelled:${routing.supportRequestId}:${data.cancelledAt}:${recipientAccountId}`,
      correlationId: input.correlationId,
    });
  return [build(routing.buyerAccountId), build(routing.sellerAccountId)];
}

export type SupportResponseReminderNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportResponseReminderData;
  correlationId: string;
}>;

/** Response reminder → the party whose response is due. */
export function mapSupportResponseReminderToNotification(
  input: SupportResponseReminderNotificationInput,
): NotificationMessage | null {
  const { routing, data } = input;
  if (data.actingRole === "support") {
    return null;
  }
  const recipientAccountId = accountForRole(routing, data.actingRole);
  return caseWebNotification({
    recipientAccountId,
    messageType: "support.support-request.response-reminder-emitted",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.responseReminder.title", {
      orderReference: orderRef(routing.orderId),
    }),
    body: t("notifications.intents.supportDispute.responseReminder.body", { deadline: deadlineLabel(data.dueAt) }),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_response_reminder",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      deadline: data.dueAt,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:response-reminder:${routing.supportRequestId}:${data.remindedAt}:${recipientAccountId}`,
    correlationId: input.correlationId,
  });
}

export type SupportReturnDeliveredNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportReturnDeliveredData;
  correlationId: string;
}>;

/** Return delivered → the seller inspects it before the window closes. */
export function mapSupportReturnDeliveredToNotification(
  input: SupportReturnDeliveredNotificationInput,
): NotificationMessage {
  const { routing, data } = input;
  return caseWebNotification({
    recipientAccountId: routing.sellerAccountId,
    messageType: "support.support-request.return-delivered",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.returnDelivered.title", {
      orderReference: orderRef(routing.orderId),
    }),
    body: t("notifications.intents.supportDispute.returnDelivered.body", {
      deadline: deadlineLabel(data.returnRefundReleaseDueAt),
    }),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_return_delivered",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      deadline: data.returnRefundReleaseDueAt,
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:return-delivered:${routing.supportRequestId}:${data.deliveredAt}:${routing.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export type SupportReturnConditionDisputedNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportReturnConditionDisputedData;
  correlationId: string;
}>;

/** Return condition disputed → the buyer learns support will review. */
export function mapSupportReturnConditionDisputedToNotification(
  input: SupportReturnConditionDisputedNotificationInput,
): NotificationMessage {
  const { routing, data } = input;
  return caseWebNotification({
    recipientAccountId: routing.buyerAccountId,
    messageType: "support.support-request.return-condition-disputed",
    criticality: "operational",
    category: "operational",
    title: t("notifications.intents.supportDispute.returnDisputed.title", {
      orderReference: orderRef(routing.orderId),
    }),
    body: t("notifications.intents.supportDispute.returnDisputed.body"),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_return_disputed",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:return-disputed:${routing.supportRequestId}:${data.disputedAt}:${routing.buyerAccountId}`,
    correlationId: input.correlationId,
  });
}

export type SupportReturnRefundReleasedNotificationInput = Readonly<{
  routing: SupportCaseRouting;
  data: SupportReturnRefundReleasedData;
  correlationId: string;
}>;

/** Return refund released → the buyer learns the refund is on its way. */
export function mapSupportReturnRefundReleasedToNotification(
  input: SupportReturnRefundReleasedNotificationInput,
): NotificationMessage {
  const { routing, data } = input;
  return caseWebNotification({
    recipientAccountId: routing.buyerAccountId,
    messageType: "support.support-request.return-refund-released",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.returnRefundReleased.title", {
      orderReference: orderRef(routing.orderId),
    }),
    body: t("notifications.intents.supportDispute.returnRefundReleased.body"),
    actionHref: CASE_LINK(routing.supportRequestId),
    templateId: "support_dispute_return_refund_released",
    templateData: {
      supportReference: caseRef(routing.supportRequestId),
      orderReference: orderRef(routing.orderId),
      actionHref: CASE_LINK(routing.supportRequestId),
    },
    idempotencyKey: `notifications:support:return-refund-released:${routing.supportRequestId}:${data.releasedAt}:${routing.buyerAccountId}`,
    correlationId: input.correlationId,
  });
}

// -- Settlement support-hold facts (seller-facing) --------------------------

export type SettlementSupportHoldNotificationInput = Readonly<{
  data: SettlementSupportHoldFactData;
  correlationId: string;
}>;

/** Hold placed → the seller learns funds for this order are held while the case is open. */
export function mapSettlementSupportHoldPlacedToNotification(
  input: SettlementSupportHoldNotificationInput,
): NotificationMessage {
  const { data } = input;
  return caseWebNotification({
    recipientAccountId: data.sellerAccountId,
    messageType: "settlement.support-hold.placed.v1",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.holdPlaced.title", { orderReference: orderRef(data.orderId) }),
    body: t("notifications.intents.supportDispute.holdPlaced.body"),
    actionHref: CASE_LINK(data.supportRequestId),
    templateId: "support_dispute_hold_placed",
    templateData: {
      holdId: data.holdId,
      supportReference: caseRef(data.supportRequestId),
      orderReference: orderRef(data.orderId),
      actionHref: CASE_LINK(data.supportRequestId),
    },
    idempotencyKey: `notifications:settlement:hold-placed:${data.holdId}:${data.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

/**
 * Hold released → the funds were returned to the seller. This copy is *only* for a
 * released hold; a hold consumed by a refund uses the consumed intent below so the
 * seller is never told funds were "released back" when they were spent.
 */
export function mapSettlementSupportHoldReleasedToNotification(
  input: Readonly<{ data: SettlementSupportHoldReleasedData; correlationId: string }>,
): NotificationMessage {
  const { data } = input;
  return caseWebNotification({
    recipientAccountId: data.sellerAccountId,
    messageType: "settlement.support-hold.released.v1",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.holdReleased.title", { orderReference: orderRef(data.orderId) }),
    body: t("notifications.intents.supportDispute.holdReleased.body"),
    actionHref: CASE_LINK(data.supportRequestId),
    templateId: "support_dispute_hold_released",
    templateData: {
      holdId: data.holdId,
      supportReference: caseRef(data.supportRequestId),
      orderReference: orderRef(data.orderId),
      releaseReason: data.releaseReason,
      actionHref: CASE_LINK(data.supportRequestId),
    },
    idempotencyKey: `notifications:settlement:hold-released:${data.holdId}:${data.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

/**
 * Hold consumed → the frozen funds were applied to the buyer's refund. The copy
 * deliberately never says "released back to you": the seller did not get the funds.
 */
export function mapSettlementSupportHoldConsumedToNotification(
  input: Readonly<{ data: SettlementSupportHoldConsumedData; correlationId: string }>,
): NotificationMessage {
  const { data } = input;
  return caseWebNotification({
    recipientAccountId: data.sellerAccountId,
    messageType: "settlement.support-hold.consumed.v1",
    criticality: "commerce",
    category: "order-critical",
    title: t("notifications.intents.supportDispute.holdConsumed.title", { orderReference: orderRef(data.orderId) }),
    body: t("notifications.intents.supportDispute.holdConsumed.body", {
      resolution: t(`notifications.intents.supportDispute.resolution.${data.resolutionType}`),
    }),
    actionHref: CASE_LINK(data.supportRequestId),
    templateId: "support_dispute_hold_consumed",
    templateData: {
      holdId: data.holdId,
      supportReference: caseRef(data.supportRequestId),
      orderReference: orderRef(data.orderId),
      resolutionType: data.resolutionType,
      actionHref: CASE_LINK(data.supportRequestId),
    },
    idempotencyKey: `notifications:settlement:hold-consumed:${data.holdId}:${data.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

// ---------------------------------------------------------------------------
// Projector — turns source facts into outbox notifications
// ---------------------------------------------------------------------------

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

function sourceFromEvent(event: TransportEvent, projectionName: string) {
  return {
    sourceEventId: event.id,
    sourceGlobalPosition: event.globalPosition,
    projectionName,
    occurredAt: event.timing.occurredAt,
  };
}

export async function projectSupportDisputeEventToNotification(
  outbox: NotificationOutbox,
  directory: SupportCaseDirectory,
  event: TransportEvent,
  projectionName: string,
) {
  const source = sourceFromEvent(event, projectionName);
  const correlationId = correlationIdFromEvent(event);
  const enqueue = async (message: NotificationMessage | null) => {
    if (message) await outbox.enqueueNotification({ message, source });
  };
  const enqueueAll = async (messages: readonly NotificationMessage[]) => {
    for (const message of messages) await outbox.enqueueNotification({ message, source });
  };

  switch (event.type) {
    case "support.support-request.opened": {
      const data = event.data as SupportOpenedData;
      const routing: SupportCaseRouting = {
        supportRequestId: data.supportRequestId,
        orderId: data.orderId,
        buyerAccountId: data.buyerAccountId,
        sellerAccountId: data.sellerAccountId,
        flowType: data.flowType,
        sellerResponseDueAt: data.sellerResponseDueAt,
      };
      await directory.recordOpenedCase({ ...routing, streamVersion: event.streamVersion });
      await enqueue(mapSupportCaseOpenedToSellerNotification({ routing, correlationId }));
      await enqueue(mapSupportCaseOpenedToBuyerNotification({ routing, correlationId }));
      return;
    }
    case "support.support-request.resolved": {
      const data = event.data as SupportResolvedData;
      await enqueueAll(mapSupportResolvedToNotifications({ data, correlationId }));
      return;
    }
    case "support.support-request.response-recorded": {
      const data = event.data as SupportResponseData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportResponseRecordedToNotification({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.offer-declined": {
      const data = event.data as SupportOfferDeclinedData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportOfferDeclinedToNotification({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.escalated": {
      const data = event.data as SupportEscalatedData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueueAll(mapSupportEscalatedToNotifications({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.cancelled": {
      const data = event.data as SupportCancelledData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueueAll(mapSupportCancelledToNotifications({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.response-reminder-emitted": {
      const data = event.data as SupportResponseReminderData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportResponseReminderToNotification({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.return-delivered": {
      const data = event.data as SupportReturnDeliveredData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportReturnDeliveredToNotification({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.return-condition-disputed": {
      const data = event.data as SupportReturnConditionDisputedData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportReturnConditionDisputedToNotification({ routing, data, correlationId }));
      return;
    }
    case "support.support-request.return-refund-released": {
      const data = event.data as SupportReturnRefundReleasedData;
      const routing = await directory.lookupCase(data.supportRequestId);
      if (!routing) return;
      await enqueue(mapSupportReturnRefundReleasedToNotification({ routing, data, correlationId }));
      return;
    }
    default:
      // Every other support-request event is classified as internal in the matrix.
      return;
  }
}

export async function projectSettlementSupportHoldFactToNotification(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName: string,
) {
  const source = sourceFromEvent(event, projectionName);
  const correlationId = correlationIdFromEvent(event);

  if (event.type === "settlement.support-hold.placed.v1") {
    const data = event.data as SettlementSupportHoldFactData;
    await outbox.enqueueNotification({
      message: mapSettlementSupportHoldPlacedToNotification({ data, correlationId }),
      source,
    });
    return;
  }
  if (event.type === "settlement.support-hold.released.v1") {
    const data = event.data as SettlementSupportHoldReleasedData;
    await outbox.enqueueNotification({
      message: mapSettlementSupportHoldReleasedToNotification({ data, correlationId }),
      source,
    });
    return;
  }
  if (event.type === "settlement.support-hold.consumed.v1") {
    const data = event.data as SettlementSupportHoldConsumedData;
    await outbox.enqueueNotification({
      message: mapSettlementSupportHoldConsumedToNotification({ data, correlationId }),
      source,
    });
  }
}

export function buildNotificationsSupportDisputeProjectionHandlers(
  outbox: NotificationOutbox,
  directory: SupportCaseDirectory,
  projectionName: string,
): ProjectorHandlerMap {
  const handler = (event: TransportEvent) =>
    projectSupportDisputeEventToNotification(outbox, directory, event, projectionName);
  return Object.fromEntries(
    SUPPORT_DISPUTE_NOTIFYING_EVENT_TYPES.map((eventType) => [eventType, handler]),
  ) as ProjectorHandlerMap;
}

export function buildNotificationsSettlementSupportHoldProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName: string,
): ProjectorHandlerMap {
  const handler = (event: TransportEvent) =>
    projectSettlementSupportHoldFactToNotification(outbox, event, projectionName);
  return Object.fromEntries(
    SETTLEMENT_SUPPORT_HOLD_FACT_TYPES.map((eventType) => [eventType, handler]),
  ) as ProjectorHandlerMap;
}

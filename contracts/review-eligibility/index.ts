// Review-eligibility policy for orders with support-request history.
//
// Shared by the marketplace reviews slice (the submission gate) and the
// ordering reputation integration (the order-detail review hint) so both
// apply one matrix and cannot drift.
//
// Review eligibility is suspended while a support request is open (reviews
// must not be weaponized mid-dispute) and restored per resolution class once
// the request concludes. The m85 dispute-self-service resolution taxonomy is
// the source of truth — this policy only maps it to eligibility; it never
// invents resolution types.
//
// The full matrix (resolution class × direction):
//
// | Support-request state                    | buyer→seller        | seller→buyer | buyer marker        |
// |------------------------------------------|---------------------|--------------|---------------------|
// | none / cancelled                         | restored¹           | restored¹    | —                   |
// | open                                     | suppressed          | suppressed   | —                   |
// | resolved: no-action                      | restored¹           | restored¹    | —                   |
// | resolved: support-reviewed               | restored¹           | restored¹    | —                   |
// | resolved: replacement                    | restored¹           | restored¹    | —                   |
// | resolved: full-refund                    | restored¹           | suppressed   | resolved-via-refund |
// | resolved: partial-refund                 | restored¹           | suppressed   | resolved-via-refund |
// | resolved: return-for-refund              | restored¹           | suppressed   | resolved-via-refund |
// | resolved: cancel-order (seller-cannot-   | restored WITHOUT a  | suppressed   | resolved-via-refund |
// |   fulfill flow — seller-caused)          | delivery²           |              |                     |
// | resolved: cancel-order (any other flow,  | suppressed          | suppressed   | —                   |
// |   e.g. buyer-cancel-request)             |                     |              |                     |
//
// ¹ Restoration still requires a delivered shipment (the delivered-orders-only
//   integrity primitive). A `replacement` resolution therefore surfaces both
//   directions again once the replacement shipment delivers — the transaction
//   was made whole and completed.
// ² A seller-caused cancellation (`seller-cannot-fulfill`) is the one case
//   where the transaction's bad outcome PREVENTS delivery, so the buyer's
//   eligibility is keyed to the resolution timestamp instead. The worst
//   sellers must not keep spotless ratings by never shipping.
//
// Direction decisions (recorded per issue #4266):
// - Buyer→seller is restored on every refund-class resolution and carries the
//   `resolved-via-refund` marker so the review displays a neutral badge.
//   Summary math is unchanged — a review is a review.
// - Seller→buyer stays restricted to benign resolutions (`no-action`,
//   `support-reviewed`, `replacement`): a seller reviewing the buyer they just
//   had to refund is the retaliation lane.
// - Buyer-at-fault outcomes (e.g. an item-not-received claim defeated by
//   delivery evidence) are encoded by m85 as `no-action` resolutions — the
//   taxonomy has no buyer-at-fault cancellation class — so seller→buyer
//   eligibility is restored for them through the `no-action` row above.
// - With multiple support requests on one order, any open request suppresses
//   both directions and the per-resolution suppressions combine: a direction
//   is eligible only if NO concluded request suppresses it. The refund marker
//   is sticky — an order that ever resolved with a refund-class outcome keeps
//   the marker on the buyer's review.

export const REVIEW_RESOLVED_VIA_REFUND = "resolved-via-refund" as const;

export type ReviewResolutionContext = typeof REVIEW_RESOLVED_VIA_REFUND;

const REFUND_RESOLUTION_TYPES: readonly string[] = ["full-refund", "partial-refund", "return-for-refund"];

const BENIGN_RESOLUTION_TYPES: readonly string[] = ["no-action", "support-reviewed", "replacement"];

const SELLER_FAULT_CANCEL_FLOW_TYPE = "seller-cannot-fulfill";

export type SupportRequestSnapshot = Readonly<{
  status: string;
  resolutionType: string | null;
  flowType: string | null;
  resolvedAt: string | null;
}>;

export type ReviewDirectionEligibility = Readonly<{
  eligible: boolean;
  eligibleAt: string | null;
  resolutionContext: ReviewResolutionContext | null;
}>;

export type ReviewEligibilityDecision = Readonly<{
  buyerToSeller: ReviewDirectionEligibility;
  sellerToBuyer: ReviewDirectionEligibility;
}>;

function isResolved(request: SupportRequestSnapshot): boolean {
  return request.status === "resolved";
}

function isSellerFaultCancel(request: SupportRequestSnapshot): boolean {
  return (
    isResolved(request) &&
    request.resolutionType === "cancel-order" &&
    request.flowType === SELLER_FAULT_CANCEL_FLOW_TYPE
  );
}

function isRefundClass(request: SupportRequestSnapshot): boolean {
  return (
    isResolved(request) &&
    (REFUND_RESOLUTION_TYPES.includes(request.resolutionType ?? "") || isSellerFaultCancel(request))
  );
}

function suppressesBuyerToSeller(request: SupportRequestSnapshot): boolean {
  // Only a non-seller-caused cancellation (e.g. a consensual buyer-cancel-
  // request) suppresses the buyer's direction: the transaction ended by
  // mutual agreement before completing, so there is nothing to review.
  // Rows written before flow_type existed have flowType = null and stay
  // conservatively suppressed until replay backfills them.
  return isResolved(request) && request.resolutionType === "cancel-order" && !isSellerFaultCancel(request);
}

function suppressesSellerToBuyer(request: SupportRequestSnapshot): boolean {
  return isResolved(request) && !BENIGN_RESOLUTION_TYPES.includes(request.resolutionType ?? "");
}

export function decideReviewEligibility(
  params: Readonly<{
    deliveredAt: string | null;
    supportRequests: readonly SupportRequestSnapshot[];
  }>,
): ReviewEligibilityDecision {
  const { deliveredAt, supportRequests } = params;

  const anyOpen = supportRequests.some((request) => request.status === "open");
  const refundResolved = supportRequests.some(isRefundClass);

  const sellerFaultCancelResolvedAt = supportRequests
    .filter(isSellerFaultCancel)
    .map((request) => request.resolvedAt)
    .filter((resolvedAt): resolvedAt is string => resolvedAt !== null)
    .sort()
    .at(-1);

  const buyerEligibleAt = deliveredAt ?? sellerFaultCancelResolvedAt ?? null;
  const buyerEligible = !anyOpen && !supportRequests.some(suppressesBuyerToSeller) && buyerEligibleAt !== null;
  const sellerEligible = !anyOpen && !supportRequests.some(suppressesSellerToBuyer) && deliveredAt !== null;

  return {
    buyerToSeller: {
      eligible: buyerEligible,
      eligibleAt: buyerEligible ? buyerEligibleAt : null,
      resolutionContext: buyerEligible && refundResolved ? REVIEW_RESOLVED_VIA_REFUND : null,
    },
    sellerToBuyer: {
      eligible: sellerEligible,
      eligibleAt: sellerEligible ? deliveredAt : null,
      resolutionContext: null,
    },
  };
}

export function normalizeResolutionContext(value: unknown): ReviewResolutionContext | null {
  return value === REVIEW_RESOLVED_VIA_REFUND ? REVIEW_RESOLVED_VIA_REFUND : null;
}

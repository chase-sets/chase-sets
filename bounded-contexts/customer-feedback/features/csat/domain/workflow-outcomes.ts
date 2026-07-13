/**
 * Stable workflow / outcome-code registry.
 *
 * This is the allow-list that invitation issuance validates against
 * so clients can never claim an arbitrary workflow. Every survey is anchored to
 * exactly one of these stable codes, and each code is owned (published) by a
 * single source context. The codes are intentionally named after the customer
 * OUTCOME (not the owning context) so they remain stable even if ownership moves.
 *
 * Coverage maps to the commerce, selling, discovery, and onboarding journeys
 * that publish outcome facts.
 */
export const csatWorkflowOutcomeCodes = [
  // Commerce completion, failure/recovery, delivery, returns, support, reputation.
  "checkout.completed",
  "checkout.recovered",
  "order.delivered",
  "return.resolved",
  "support.request-resolved",
  "reputation.review-received",
  // Selling outcomes.
  "listing.published",
  "offer.accepted",
  "inventory.item-adjusted",
  "payout.completed",
  // Sampled discovery and account-onboarding outcomes.
  "discovery.search-completed",
  "registration.completed",
  "authentication.completed",
  "onboarding.completed",
] as const;

export type CsatWorkflowOutcomeCode = (typeof csatWorkflowOutcomeCodes)[number];

/**
 * The bounded context that OWNS and publishes each outcome fact. Customer Feedback
 * never reaches into these contexts; it only consumes the facts they publish
 * (see `./outcome-fact`). This map is the provenance authority: an invitation's
 * `sourceContext` must equal the owner recorded here for its outcome code.
 */
export const csatWorkflowOutcomeSourceContext = {
  "checkout.completed": "checkout",
  "checkout.recovered": "checkout",
  "order.delivered": "fulfillment",
  "return.resolved": "platform-operations",
  "support.request-resolved": "platform-operations",
  "reputation.review-received": "marketplace",
  "listing.published": "marketplace",
  "offer.accepted": "marketplace",
  "inventory.item-adjusted": "inventory",
  "payout.completed": "settlement",
  "discovery.search-completed": "discovery",
  "registration.completed": "identity",
  "authentication.completed": "auth",
  "onboarding.completed": "identity",
} as const satisfies Record<CsatWorkflowOutcomeCode, string>;

export function isCsatWorkflowOutcomeCode(value: string): value is CsatWorkflowOutcomeCode {
  return (csatWorkflowOutcomeCodes as readonly string[]).includes(value);
}

export function sourceContextForOutcomeCode(code: CsatWorkflowOutcomeCode): string {
  return csatWorkflowOutcomeSourceContext[code];
}

/**
 * Validate a claimed (code, sourceContext) pair against the registry. Issuance uses
 * this when redeeming a server-issued outcome fact into an invitation so a fact
 * cannot assert a code it does not own.
 */
export function isProvenanceAuthoritative(code: string, sourceContext: string): code is CsatWorkflowOutcomeCode {
  return isCsatWorkflowOutcomeCode(code) && csatWorkflowOutcomeSourceContext[code] === sourceContext;
}

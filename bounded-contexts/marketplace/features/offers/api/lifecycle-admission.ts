import type { MarketplaceOfferEvent } from "../domain/domain";

/** The Offer lifecycle events added to the existing Discovery, Checkout and Pricing Offer subscriptions. */
export const MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES = [
  "marketplace.offer.paused",
  "marketplace.offer.resumed",
  "marketplace.offer.withdrawn",
] as const satisfies readonly MarketplaceOfferEvent["type"][];

/** Every open-Offer consumer reads this event, so a worker that reads it must also read the lifecycle events. */
export const MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE =
  "marketplace.offer.submitted" satisfies MarketplaceOfferEvent["type"];

/**
 * Admits Pause, Resume and Withdraw. An old worker filters these events out of its unchanged
 * subscription and can checkpoint past them, losing them for good, so the host opens admission only
 * once every worker that can still be running reads them. Without this port the lifecycle commands stay closed.
 */
export type MarketplaceOfferLifecycleAdmission = Readonly<{
  check: () => Promise<Readonly<{ admitted: true }> | Readonly<{ admitted: false; reason: string }>>;
}>;

export class MarketplaceOfferLifecycleClosedError extends Error {
  public readonly code = "offer_lifecycle_closed";

  public constructor(public readonly reason: string) {
    super("Offer lifecycle changes are not open yet.");
    this.name = "MarketplaceOfferLifecycleClosedError";
  }
}

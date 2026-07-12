import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

type ClaimFounderNumber = (
  params: Readonly<{
    accountId: string;
    qualifyingActType: "listing-created" | "offer-submitted";
    qualifyingActId: string;
    claimedAt: string;
  }>,
  context: EventStoreContext,
) => Promise<unknown>;

function eventContext(event: {
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

export function buildFounderClaimReactionHandlers(claimFounderNumber: ClaimFounderNumber): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as { accountId: string; listingId: string };
      await claimFounderNumber(
        {
          accountId: data.accountId,
          qualifyingActType: "listing-created",
          qualifyingActId: data.listingId,
          claimedAt: event.timing.occurredAt,
        },
        eventContext(event),
      );
    },
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as { buyerAccountId: string; offerId: string };
      await claimFounderNumber(
        {
          accountId: data.buyerAccountId,
          qualifyingActType: "offer-submitted",
          qualifyingActId: data.offerId,
          claimedAt: event.timing.occurredAt,
        },
        eventContext(event),
      );
    },
  };
}

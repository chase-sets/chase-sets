import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { parsePlatformOperationsListingRemovalDirectedPayload } from "@chase-sets/event-core/public-event-payloads";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceListingServices } from "../../api/runtime";

export type ListingModerationReactionDeps = Pick<MarketplaceListingServices, "operatorUnlistListing">;

export function buildListingModerationReactionHandlers(deps: ListingModerationReactionDeps): ProjectorHandlerMap {
  return {
    "platform-operations.reported-content.listing-removal-directed": async (event) => {
      const directive = parsePlatformOperationsListingRemovalDirectedPayload(event.data);
      const params = {
        listingId: directive.listingId,
        sourceActionId: directive.actionId,
        listingEnforcementActionId: createId("lea"),
        recordedAt: directive.directedAt,
      };
      const context = { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
      try {
        await deps.operatorUnlistListing(params, context);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "concurrency_conflict"
        ) {
          throw error;
        }
        await deps.operatorUnlistListing(params, context);
      }
    },
  };
}

import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { FulfillmentObservationServices } from "../api/runtime";

export function buildFulfillmentObservationReactions(services: FulfillmentObservationServices): ProjectorHandlerMap {
  return {
    "inventory.external-channel-sale.recorded": async (event) => {
      const connectionId = event.data.connectionAuditReference;
      if (typeof connectionId === "string") await services.interpretConnection(connectionId);
    },
    "channels.channel-listing.desired-state-changed": async (event) => {
      const connectionId = event.data.connectionId;
      if (typeof connectionId === "string") await services.interpretConnection(connectionId);
    },
    "channels.channel-publication-configuration.mapping-review-decided": async (event) => {
      const connectionId = event.data.connectionId;
      if (typeof connectionId === "string") await services.interpretConnection(connectionId);
    },
  };
}

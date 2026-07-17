import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketPriceEstimatedEvent } from "../../market-estimates/domain/domain";
import type { RepricingEngineServices, RepricingEvaluationTrigger } from "../api/runtime";

const competingAskEventTypes = [
  "marketplace.listing.created",
  "marketplace.listing.price-updated",
  "marketplace.listing.quantity-cap-updated",
  "marketplace.listing.published",
  "marketplace.listing.paused",
  "marketplace.listing.withdrawn",
] as const;

type SignalEvent = Readonly<{
  id: string;
  type: string;
  streamId: string;
  streamVersion: number;
  data: Record<string, unknown>;
  tenantId: string;
  audit: Readonly<{ performedByUserId: string; forAccountId: string }>;
  timing: Readonly<{ occurredAt: string; recordedAt: string }>;
}>;

function eventContext(event: SignalEvent): EventStoreContext {
  return {
    tenantId: event.tenantId as never,
    audit: {
      performedByUserId: event.audit.performedByUserId as never,
      forAccountId: event.audit.forAccountId as never,
    },
  };
}

function trigger(
  event: SignalEvent,
  kind: RepricingEvaluationTrigger["kind"],
  signalVersion: string,
): RepricingEvaluationTrigger {
  return {
    kind,
    eventId: event.id,
    signalVersion,
    occurredAt: event.timing.occurredAt,
  };
}

export function buildMarketPriceRepricingReactionHandlers(engine: RepricingEngineServices): ProjectorHandlerMap {
  return {
    "pricing.market-price.estimated": async (untypedEvent) => {
      const event = untypedEvent as unknown as SignalEvent;
      const data = event.data as unknown as MarketPriceEstimatedEvent["data"];
      await engine.enqueueMarketPriceSignal({
        catalogItemId: data.catalogItemId,
        productId: data.productId,
        amount: data.amount,
        previousAmount: data.previousAmount,
        trigger: trigger(event, "market-price-estimated", data.estimateVersion),
        context: eventContext(event),
      });
    },
  };
}

export function buildCompetingAskRepricingReactionHandlers(engine: RepricingEngineServices): ProjectorHandlerMap {
  return Object.fromEntries(
    competingAskEventTypes.map((eventType) => [
      eventType,
      async (untypedEvent: unknown) => {
        const event = untypedEvent as SignalEvent;
        if (event.type === "marketplace.listing.price-updated" && event.data.changeSource === "repricing-engine") {
          return;
        }
        const listingId =
          event.type === "marketplace.listing.created" && typeof event.data.listingId === "string"
            ? event.data.listingId
            : extractIdFromStreamId(event.streamId, "marketplace.listing-");
        await engine.enqueueCompetingAskSignal({
          listingId,
          trigger: trigger(event, "competing-ask-changed", String(event.streamVersion)),
          context: eventContext(event),
        });
      },
    ]),
  );
}

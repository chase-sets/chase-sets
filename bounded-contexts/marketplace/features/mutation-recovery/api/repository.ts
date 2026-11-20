import type { DomainEvent } from "@chase-sets/event-core/domain";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { readMarketplaceRecoveryHistory } from "../domain/history";
import { MarketplaceAttemptError } from "./attempt";

export function marketplaceRecoveryLoader<S, E extends DomainEvent>(
  store: Pick<EventStore, "readStream">,
  initial: S,
  codec: DomainEventCodec<E>,
  evolve: (state: S, event: E) => S,
) {
  return async (streamId: string) => {
    const history = await readMarketplaceRecoveryHistory(
      store,
      streamId,
      { state: initial, version: 0, events: [] as E[], storedEvents: [] as StoredEvent[] },
      (loaded, event) => {
        const decoded = codec.decode(event);
        loaded.events.push(decoded);
        loaded.storedEvents.push(event);
        return {
          state: evolve(loaded.state, decoded),
          version: event.streamVersion,
          events: loaded.events,
          storedEvents: loaded.storedEvents,
        };
      },
    );
    if (!history.complete)
      throw new MarketplaceAttemptError("history_incomplete", "Marketplace recovery history is incomplete.");
    return history.state;
  };
}

import type { DomainEvent } from "./domain";
import type { EventRecordToStore, StoredEvent } from "./storage";

export type DomainEventCodec<Event extends DomainEvent = DomainEvent> = Readonly<{
  encode: (event: Readonly<Event>) => EventRecordToStore;
  decode: (storedEvent: Pick<StoredEvent, "eventType" | "payload">) => Event;
}>;

export function createPassthroughDomainEventCodec<Event extends DomainEvent>(): DomainEventCodec<Event> {
  return {
    encode: (event) => ({
      eventType: event.type,
      payload: event.data,
    }),
    decode: (storedEvent) =>
      ({
        type: storedEvent.eventType,
        data: storedEvent.payload,
      }) as Event,
  };
}

import type { DomainEvent } from "@chase-sets/event-core";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { InventoryExternalChannelSaleRecordedPayload } from "@chase-sets/event-core/public-event-payloads";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { EXTERNAL_CHANNEL_SALE_EVENT_TYPE, isClosedExternalChannelSaleEventPayload } from "./validation";

export type InventoryExternalChannelSaleRecordedEvent = DomainEvent<
  typeof EXTERNAL_CHANNEL_SALE_EVENT_TYPE,
  InventoryExternalChannelSaleRecordedPayload
>;

export const externalChannelSaleEventCodec: DomainEventCodec<InventoryExternalChannelSaleRecordedEvent> = {
  encode: (event) => {
    if (event.type !== EXTERNAL_CHANNEL_SALE_EVENT_TYPE || !isClosedExternalChannelSaleEventPayload(event.data)) {
      throw new InventoryDomainError("External channel sale event is invalid.");
    }
    return { eventType: event.type, payload: event.data };
  },
  decode: (storedEvent) => {
    if (
      storedEvent.eventType !== EXTERNAL_CHANNEL_SALE_EVENT_TYPE ||
      !isClosedExternalChannelSaleEventPayload(storedEvent.payload)
    ) {
      throw new InventoryDomainError("External channel sale event is invalid.");
    }
    return { type: EXTERNAL_CHANNEL_SALE_EVENT_TYPE, data: storedEvent.payload };
  },
};

import type { DomainEvent } from "@chase-sets/event-core";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { InventoryChannelStockAllocationSetPayload } from "@chase-sets/event-core/public-event-payloads/inventory";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { assertChannelStockAllocationEventPayload, CHANNEL_STOCK_ALLOCATION_EVENT_TYPE } from "./allocation";

export type InventoryChannelStockAllocationSetEvent = DomainEvent<
  typeof CHANNEL_STOCK_ALLOCATION_EVENT_TYPE,
  InventoryChannelStockAllocationSetPayload
>;

export const channelStockAllocationEventCodec: DomainEventCodec<InventoryChannelStockAllocationSetEvent> = {
  encode: (event) => {
    if (event.type !== CHANNEL_STOCK_ALLOCATION_EVENT_TYPE) {
      throw new InventoryDomainError("Channel Stock Allocation event type is invalid.");
    }
    assertChannelStockAllocationEventPayload(event.data);
    return { eventType: event.type, payload: event.data };
  },
  decode: (storedEvent) => {
    if (storedEvent.eventType !== CHANNEL_STOCK_ALLOCATION_EVENT_TYPE) {
      throw new InventoryDomainError("Channel Stock Allocation event type is invalid.");
    }
    assertChannelStockAllocationEventPayload(storedEvent.payload);
    return { type: CHANNEL_STOCK_ALLOCATION_EVENT_TYPE, data: storedEvent.payload };
  },
};

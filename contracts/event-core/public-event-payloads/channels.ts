import type { ShippingOption } from "../../product-measures";
import type { ExternalChannelSaleKeyV1Payload } from "./inventory";

export type ChannelOrderFulfillmentStatus = "active" | "cancelled" | "refunded";
export type ChannelOrderFulfillmentIdentity = Readonly<{
  accountId: string;
  connectionId: string;
  providerKey: string;
  externalOrderReference: string;
}>;
export type ChannelOrderFulfillmentAcceptedPayload = ChannelOrderFulfillmentIdentity &
  Readonly<{
    status: ChannelOrderFulfillmentStatus;
    orderedAt: string;
    acceptedAt: string;
    shippingOption: ShippingOption;
    shipTo: Readonly<{
      name: string;
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      phone?: string;
    }>;
    lines: readonly Readonly<{
      saleKey: ExternalChannelSaleKeyV1Payload;
      inventoryItemId: string;
      storageLocationId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      quantity: number;
      unitPriceAmount: string;
    }>[];
    productAmount: string;
    shippingAmount: string;
    currencyCode: string;
  }>;
export type ChannelOrderFulfillmentStatusChangedPayload = ChannelOrderFulfillmentIdentity &
  Readonly<{
    status: ChannelOrderFulfillmentStatus;
  }>;
export type ChannelsEventPayloads = {
  "channels.order-fulfillment-observation.accepted": ChannelOrderFulfillmentAcceptedPayload;
  "channels.order-fulfillment-observation.status-changed": ChannelOrderFulfillmentStatusChangedPayload;
};

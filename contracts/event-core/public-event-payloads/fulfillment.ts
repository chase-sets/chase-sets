// Fulfillment-owned public event payloads.
import type { AddressSnapshot } from "../../primitives/address-snapshot";
import type { ProductKey } from "../../primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId, ShipmentId, TypedUlid } from "../../primitives/typed-ids";
import type { PackagePlan } from "../../product-measures";

export type FulfillmentShipmentLinePayload = Readonly<{
  lineId: TypedUlid<"spl">;
  orderLineId: string;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemTitle: string;
  itemSubtitle: string | null;
  productSummary: string | null;
  quantity: number;
  packingConfirmedQuantity: number;
  packingConfirmedAt: string | null;
}>;

export type FulfillmentAddressOverrideAuditPayload = Readonly<{
  originalSenderSnapshot: AddressSnapshot;
  submittedSenderAddress: AddressSnapshot;
  originalRecipientSnapshot: AddressSnapshot;
  submittedRecipientAddress: AddressSnapshot;
  changedSide: "sender" | "recipient" | "both";
  reason: string;
  actor: string;
  timestamp: string;
}>;

export type FulfillmentShipmentCreatedPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  shippingOption: string;
  shippingDestinationSnapshot: AddressSnapshot;
  shippingOriginSnapshot: AddressSnapshot;
  shippingPlanSnapshot: PackagePlan | null;
  lines: readonly FulfillmentShipmentLinePayload[];
  createdAt: string;
}>;

export type FulfillmentShipmentPackingStartedPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  startedAt: string;
}>;

export type FulfillmentShipmentPackagePreparedPayload = Readonly<{
  shipmentId: ShipmentId;
  packageCount: number;
  preparedAt: string;
}>;

export type FulfillmentShipmentLabelAttachedPayload = Readonly<{
  shipmentId: ShipmentId;
  shippingMethod: "standard" | "expedited" | "priority" | "insured";
  carrierName: string;
  labelReference: string;
  labelDocumentUrl: string | null;
  trackingIdentifier: string;
  postageProviderName: string | null;
  postageProviderMode: string | null;
  postageProviderShipmentId: string | null;
  postageProviderLabelId: string | null;
  postageRateId: string | null;
  postageServiceLevel: string | null;
  postageAmountCents: number | null;
  postageCurrency: string | null;
  addressOverrideAudit: FulfillmentAddressOverrideAuditPayload | null;
  attachedAt: string;
}>;

type HistoricalFulfillmentShipmentDispatchedPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId?: never;
  buyerAccountId?: never;
  sellerAccountId?: never;
  trackingIdentifier?: never;
  dispatchedAt: string;
}>;

type EnrichedFulfillmentShipmentDispatchedPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  trackingIdentifier: string | null;
  dispatchedAt: string;
}>;

/**
 * Dispatch routing was added atomically after the fact name was already durable.
 * Historical events contain neither routing field; current publishers contain all
 * four. Partial enrichment is not a valid historical shape.
 */
export type FulfillmentShipmentDispatchedPayload =
  | HistoricalFulfillmentShipmentDispatchedPayload
  | EnrichedFulfillmentShipmentDispatchedPayload;

export type FulfillmentShipmentDeliveredPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  shippingDestinationSnapshot: AddressSnapshot;
  trackingIdentifier: string | null;
  deliveredAt: string;
}>;

export type FulfillmentShipmentCancelledPayload = Readonly<{
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  cancelledAt: string;
}>;

export type FulfillmentEventPayloads = Readonly<{
  "fulfillment.shipment.created": FulfillmentShipmentCreatedPayload;
  "fulfillment.shipment.packing-started": FulfillmentShipmentPackingStartedPayload;
  "fulfillment.shipment.package-prepared": FulfillmentShipmentPackagePreparedPayload;
  "fulfillment.shipment.label-attached": FulfillmentShipmentLabelAttachedPayload;
  "fulfillment.shipment.dispatched": FulfillmentShipmentDispatchedPayload;
  "fulfillment.shipment.delivered": FulfillmentShipmentDeliveredPayload;
  "fulfillment.shipment.cancelled": FulfillmentShipmentCancelledPayload;
}>;

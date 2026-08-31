// Inventory-owned public event payloads.
import type { AccountId, CheckoutSessionId } from "../../primitives/typed-ids";

export type InventoryReservationConfirmedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  holdId: string;
}>;

export type InventoryReservationRejectedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  reason: string;
}>;

export type InventoryReservationReleasedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  holdId: string;
  sellerAccountId: AccountId;
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export const inventoryHoldPurposes = ["order", "manual", "checkout", "pos", "channel", "transfer"] as const;

export type InventoryHoldPurpose = (typeof inventoryHoldPurposes)[number];

export const inventoryHoldReleaseReasons = [
  "order-cancelled",
  "checkout-cancelled",
  "checkout-expired",
  "payment-deadline",
  "hold-collision",
  "manual",
  "superseded",
] as const;

export type InventoryHoldReleaseReason = (typeof inventoryHoldReleaseReasons)[number];

export type InventoryHoldOrderSourceRef = Readonly<{
  orderId: string;
  reservationRequestId: string;
}>;

export type InventoryHoldCheckoutSourceRef = Readonly<{
  checkoutSessionId: CheckoutSessionId;
  lineKey: string;
}>;

export type InventoryHoldSourceRef = InventoryHoldOrderSourceRef | InventoryHoldCheckoutSourceRef | null;

export type InventoryHoldPlacedPayload = Readonly<{
  holdId: string;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes: string | null;
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
}>;

export type InventoryHoldReleasedPayload = Readonly<{
  holdId: string;
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export type InventoryHoldConvertedPayload = Readonly<{
  holdId: string;
  convertedAt: string;
  purpose: "order";
  sourceRef: InventoryHoldOrderSourceRef;
  expiresAt: null;
}>;

export type InventoryHoldExpiredPayload = Readonly<{
  holdId: string;
  expiredAt: string;
}>;

export type InventoryHoldExtendedPayload = Readonly<{
  holdId: string;
  extendedAt: string;
  expiresAt: string;
  extensionCount: number;
}>;

export type InventoryHoldConsumedPayload = Readonly<{
  holdId: string;
  consumedAt: string;
  consumptionReason: string;
  sourceRef: InventoryHoldSourceRef;
}>;

export type InventoryHoldCollisionRecordedPayload = Readonly<{
  collisionId: string;
  accountId: AccountId;
  itemId: string;
  storageLocationId: string;
  reason: string;
  mode: "protect-orders" | "honor-offline";
  authorizedByRole: "manager" | "owner" | "platform-admin" | null;
  requestedQuantity: number;
  appliedQuantity: number;
  refusedQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  releasedHoldQuantity: number;
  totalQuantityBefore: number;
  totalQuantityAfter: number;
  affectedOrders: readonly Readonly<{
    holdId: string;
    orderId: string;
    reservationRequestId: string;
    quantity: number;
    disposition: "protected" | "released";
  }>[];
  recordedAt: string;
}>;

export const inventoryRestockDecisionOutcomes = ["restocked", "written-off"] as const;

export type InventoryRestockDecisionOutcome = (typeof inventoryRestockDecisionOutcomes)[number];

export const inventoryAdjustmentReasons = [
  "sold-offline",
  "damaged",
  "lost",
  "found",
  "correction",
  "intake",
  "return-restocked",
] as const;

export type InventoryAdjustmentReason = (typeof inventoryAdjustmentReasons)[number];

export function isInventoryAdjustmentReason(value: unknown): value is InventoryAdjustmentReason {
  return inventoryAdjustmentReasons.includes(value as InventoryAdjustmentReason);
}

export type InventoryAdjustmentSourceRef = InventoryHoldSourceRef;

export type InventoryItemAdjustedPayload = Readonly<{
  itemId: string;
  quantityDelta: number;
  reason: string;
  reasonCode?: InventoryAdjustmentReason;
  note?: string | null;
  sourceRef?: InventoryAdjustmentSourceRef;
}>;

export const inventoryOfflineSaleChannels = ["in-store", "card-show", "other"] as const;

export type InventoryOfflineSaleChannel = (typeof inventoryOfflineSaleChannels)[number];

export function isInventoryOfflineSaleChannel(value: unknown): value is InventoryOfflineSaleChannel {
  return inventoryOfflineSaleChannels.includes(value as InventoryOfflineSaleChannel);
}

export type InventoryItemOfflineSaleRecordedPayload = Readonly<{
  itemId: string;
  quantity: number;
  salePriceAmount: string | null;
  channel: InventoryOfflineSaleChannel;
  storageLocationId: string;
  acquisitionCostAmount: string | null;
  recordedAt: string;
}>;

export type InventoryRestockDecisionPendingPayload = Readonly<{
  decisionId: string;
  accountId: AccountId;
  orderId: string;
  itemId: string;
  quantity: number;
  source: "order-cancelled-after-dispatch" | "shipment-returned";
  sourceRef: InventoryHoldSourceRef;
  shipmentId: string | null;
  returnReason: string | null;
  pendingAt: string;
}>;

export type InventoryRestockDecisionRecordedPayload = Readonly<{
  decisionId: string;
  accountId: AccountId;
  orderId: string;
  itemId: string;
  quantity: number;
  outcome: InventoryRestockDecisionOutcome;
  reason: "return-restocked" | "written-off";
  sourceRef: InventoryHoldSourceRef;
  damageNote: string | null;
  decidedAt: string;
}>;

export type InventoryRecoveredItemDispositionPayload = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  disposition:
    | "return-to-original-seller"
    | "return-to-buyer"
    | "platform-resale"
    | "liquidation"
    | "donation"
    | "destruction"
    | "carrier-claim"
    | "lost-unresolved";
  policyVersion: string;
  authorityKind: string | null;
  evidenceReferences: readonly string[];
  targetAccountId: string | null;
  storageLocationId: string | null;
  occurredAt: string;
}>;

export type InventoryRecoveredItemAuthenticityReviewRequestedPayload = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  policyVersion: string;
  reasonCode: string;
  requestedByUserId: string;
  evidenceReferences: readonly string[];
  requestedAt: string;
}>;

export type InventoryRecoveredItemValueReportedPayload = Readonly<{
  factSchemaVersion: 1;
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  recoveryId: string;
  recoveryType: "resale-proceeds" | "liquidation-proceeds" | "carrier-claim" | "postage-refund" | "disposition-cost";
  grossAmount: string;
  costAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  recordedAt: string;
}>;

export type InventoryEventPayloads = Readonly<{
  "inventory.item.adjusted": InventoryItemAdjustedPayload;
  "inventory.item.offline-sale-recorded": InventoryItemOfflineSaleRecordedPayload;
  "inventory.hold.placed": InventoryHoldPlacedPayload;
  "inventory.hold.released": InventoryHoldReleasedPayload;
  "inventory.hold.converted": InventoryHoldConvertedPayload;
  "inventory.hold.expired": InventoryHoldExpiredPayload;
  "inventory.hold.extended": InventoryHoldExtendedPayload;
  "inventory.hold.consumed": InventoryHoldConsumedPayload;
  "inventory.hold-collision-recorded": InventoryHoldCollisionRecordedPayload;
  "inventory.reservation.confirmed": InventoryReservationConfirmedPayload;
  "inventory.reservation.rejected": InventoryReservationRejectedPayload;
  "inventory.reservation.released": InventoryReservationReleasedPayload;
  "inventory.restock-decision.pending": InventoryRestockDecisionPendingPayload;
  "inventory.restock-decision.recorded": InventoryRestockDecisionRecordedPayload;
  "inventory.recovered-item.authenticity-review-required.v1": InventoryRecoveredItemAuthenticityReviewRequestedPayload;
  "inventory.recovered-item.sellable.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.transferred.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.disposed.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.value-reported.v1": InventoryRecoveredItemValueReportedPayload;
}>;

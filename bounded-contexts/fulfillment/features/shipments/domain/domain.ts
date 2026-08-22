import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId, ShipmentId } from "@chase-sets/primitives/typed-ids";
import type { PackagePlan } from "@chase-sets/product-measures";
import {
  createFulfillmentCsatOutcomeFact,
  fulfillmentCsatOutcomeFactEventType,
} from "../../../support/request-support/csat-outcome-fact";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  ensureNonNegativeInteger,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShipmentExceptionType,
  normalizeShippingMethod,
  type PackageStatus,
  type PostageLabelStatus,
  type ShipmentExceptionType,
  type ShipmentLineId,
  type ShipmentStatus,
  type ShippingMethod,
} from "./common";

export type FulfillmentShipmentLine = Readonly<{
  lineId: ShipmentLineId;
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

export type FulfillmentShipmentLineInput = Omit<
  FulfillmentShipmentLine,
  "packingConfirmedAt" | "packingConfirmedQuantity"
> &
  Readonly<{ packingConfirmedAt?: string | null; packingConfirmedQuantity?: number | null }>;

export type FulfillmentShipmentException = Readonly<{
  exceptionType: ShipmentExceptionType;
  notes: string | null;
  raisedAt: string;
}>;

export type FulfillmentAddressOverrideAudit = Readonly<{
  originalSenderSnapshot: AddressSnapshot;
  submittedSenderAddress: AddressSnapshot;
  originalRecipientSnapshot: AddressSnapshot;
  submittedRecipientAddress: AddressSnapshot;
  changedSide: "sender" | "recipient" | "both";
  reason: string;
  actor: string;
  timestamp: string;
}>;

export type FulfillmentShipmentState = Readonly<{
  shipmentId: ShipmentId | null;
  orderId: OrderId | null;
  buyerAccountId: AccountId | null;
  sellerAccountId: AccountId | null;
  shippingOption: string | null;
  shippingDestinationSnapshot: AddressSnapshot | null;
  shippingOriginSnapshot: AddressSnapshot | null;
  shippingPlanSnapshot: PackagePlan | null;
  shippingMethod: ShippingMethod | null;
  carrierName: string | null;
  labelReference: string | null;
  labelDocumentUrl: string | null;
  trackingIdentifier: string | null;
  postageProviderName: string | null;
  postageProviderMode: string | null;
  postageProviderShipmentId: string | null;
  postageProviderLabelId: string | null;
  postageRateId: string | null;
  postageServiceLevel: string | null;
  postageAmountCents: number | null;
  postageCurrency: string | null;
  labelStatus: PostageLabelStatus;
  labelErrorCode: string | null;
  labelErrorMessage: string | null;
  labelRefundStatus: string | null;
  labelRefundReference: string | null;
  status: ShipmentStatus | null;
  packageStatus: PackageStatus | null;
  packageCount: number | null;
  lines: FulfillmentShipmentLine[];
  exceptions: FulfillmentShipmentException[];
  addressOverrideAudits: FulfillmentAddressOverrideAudit[];
  createdAt: string | null;
  packingStartedAt: string | null;
  packagePreparedAt: string | null;
  labelAttachedAt: string | null;
  labelVoidedAt: string | null;
  cancelledAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  currentExceptionType: ShipmentExceptionType | null;
  currentExceptionNotes: string | null;
  exceptionRaisedAt: string | null;
}>;

export const initialFulfillmentShipmentState: FulfillmentShipmentState = {
  shipmentId: null,
  orderId: null,
  buyerAccountId: null,
  sellerAccountId: null,
  shippingOption: null,
  shippingDestinationSnapshot: null,
  shippingOriginSnapshot: null,
  shippingPlanSnapshot: null,
  shippingMethod: null,
  carrierName: null,
  labelReference: null,
  labelDocumentUrl: null,
  trackingIdentifier: null,
  postageProviderName: null,
  postageProviderMode: null,
  postageProviderShipmentId: null,
  postageProviderLabelId: null,
  postageRateId: null,
  postageServiceLevel: null,
  postageAmountCents: null,
  postageCurrency: null,
  labelStatus: "not-purchased",
  labelErrorCode: null,
  labelErrorMessage: null,
  labelRefundStatus: null,
  labelRefundReference: null,
  status: null,
  packageStatus: null,
  packageCount: null,
  lines: [],
  exceptions: [],
  addressOverrideAudits: [],
  createdAt: null,
  packingStartedAt: null,
  packagePreparedAt: null,
  labelAttachedAt: null,
  labelVoidedAt: null,
  cancelledAt: null,
  dispatchedAt: null,
  deliveredAt: null,
  returnedAt: null,
  currentExceptionType: null,
  currentExceptionNotes: null,
  exceptionRaisedAt: null,
};

function labelStatusFromRefundStatus(refundStatus: string): PostageLabelStatus {
  if (refundStatus === "refunded") {
    return "voided";
  }
  if (refundStatus === "rejected") {
    return "void-rejected";
  }
  return "void-requested";
}

function shipmentStatusFromRefundStatus(refundStatus: string): ShipmentStatus {
  return refundStatus === "rejected" ? "label-attached" : "awaiting-label";
}

export type CreateShipmentCommand = Readonly<{
  type: "CreateShipment";
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  shippingOption: string;
  shippingDestinationSnapshot: AddressSnapshot;
  shippingOriginSnapshot: AddressSnapshot;
  shippingPlanSnapshot?: PackagePlan | null;
  lines: readonly FulfillmentShipmentLineInput[];
  createdAt: string;
}>;

export type PrepareShipmentPackageCommand = Readonly<{
  type: "PrepareShipmentPackage";
  packageCount: number;
  preparedAt: string;
}>;

export type StartShipmentPackingCommand = Readonly<{
  type: "StartShipmentPacking";
  startedAt: string;
}>;

export type ConfirmShipmentPackingLineCommand = Readonly<{
  type: "ConfirmShipmentPackingLine";
  lineId: ShipmentLineId;
  confirmedAt: string;
}>;

export type UnconfirmShipmentPackingLineCommand = Readonly<{
  type: "UnconfirmShipmentPackingLine";
  lineId: ShipmentLineId;
  unconfirmedAt: string;
}>;

export type SetShipmentPackingLineQuantityCommand = Readonly<{
  type: "SetShipmentPackingLineQuantity";
  lineId: ShipmentLineId;
  confirmedQuantity: number;
  setAt: string;
}>;

export type AttachShipmentLabelCommand = Readonly<{
  type: "AttachShipmentLabel";
  shippingMethod: ShippingMethod;
  carrierName: string;
  labelReference: string;
  labelDocumentUrl?: string | null;
  trackingIdentifier: string;
  postageProviderName?: string | null;
  postageProviderMode?: string | null;
  postageProviderShipmentId?: string | null;
  postageProviderLabelId?: string | null;
  postageRateId?: string | null;
  postageServiceLevel?: string | null;
  postageAmountCents?: number | null;
  postageCurrency?: string | null;
  addressOverrideAudit?: FulfillmentAddressOverrideAudit | null;
  attachedAt: string;
}>;

export type RecordShipmentLabelPurchaseFailedCommand = Readonly<{
  type: "RecordShipmentLabelPurchaseFailed";
  postageProviderName: string;
  postageProviderMode: string;
  errorCode?: string | null;
  errorMessage: string;
  failedAt: string;
}>;

export type VoidShipmentLabelCommand = Readonly<{
  type: "VoidShipmentLabel";
  refundStatus: string;
  refundReference?: string | null;
  voidedAt: string;
}>;

export type RecordShipmentLabelRefundStatusCommand = Readonly<{
  type: "RecordShipmentLabelRefundStatus";
  refundStatus: string;
  refundReference?: string | null;
  resolvedAt: string;
}>;

export type CancelShipmentCommand = Readonly<{
  type: "CancelShipment";
  cancelledAt: string;
}>;

export type DispatchShipmentCommand = Readonly<{
  type: "DispatchShipment";
  dispatchedAt: string;
}>;

export type RecordShipmentDeliveryCommand = Readonly<{
  type: "RecordShipmentDelivery";
  deliveredAt: string;
}>;

export type ReturnShipmentCommand = Readonly<{
  type: "ReturnShipment";
  reason: string | null;
  returnedAt: string;
}>;

export type RaiseShipmentExceptionCommand = Readonly<{
  type: "RaiseShipmentException";
  exceptionType: ShipmentExceptionType;
  notes: string | null;
  raisedAt: string;
}>;

export type FulfillmentShipmentCommand =
  | CreateShipmentCommand
  | StartShipmentPackingCommand
  | ConfirmShipmentPackingLineCommand
  | UnconfirmShipmentPackingLineCommand
  | SetShipmentPackingLineQuantityCommand
  | PrepareShipmentPackageCommand
  | AttachShipmentLabelCommand
  | RecordShipmentLabelPurchaseFailedCommand
  | VoidShipmentLabelCommand
  | RecordShipmentLabelRefundStatusCommand
  | CancelShipmentCommand
  | DispatchShipmentCommand
  | RecordShipmentDeliveryCommand
  | ReturnShipmentCommand
  | RaiseShipmentExceptionCommand;

export type ShipmentCreatedEvent = DomainEvent<
  "fulfillment.shipment.created",
  Readonly<{
    shipmentId: ShipmentId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    shippingOption: string;
    shippingDestinationSnapshot: AddressSnapshot;
    shippingOriginSnapshot: AddressSnapshot;
    shippingPlanSnapshot: PackagePlan | null;
    lines: FulfillmentShipmentLine[];
    createdAt: string;
  }>
>;

export type ShipmentPackagePreparedEvent = DomainEvent<
  "fulfillment.shipment.package-prepared",
  Readonly<{
    shipmentId: ShipmentId;
    packageCount: number;
    preparedAt: string;
  }>
>;

export type ShipmentPackingStartedEvent = DomainEvent<
  "fulfillment.shipment.packing-started",
  Readonly<{
    shipmentId: ShipmentId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    startedAt: string;
  }>
>;

export type ShipmentPackingLineConfirmedEvent = DomainEvent<
  "fulfillment.shipment.packing-line-confirmed",
  Readonly<{
    shipmentId: ShipmentId;
    lineId: ShipmentLineId;
    confirmedAt: string;
  }>
>;

export type ShipmentPackingLineUnconfirmedEvent = DomainEvent<
  "fulfillment.shipment.packing-line-unconfirmed",
  Readonly<{
    shipmentId: ShipmentId;
    lineId: ShipmentLineId;
    unconfirmedAt: string;
  }>
>;

export type ShipmentPackingLineQuantitySetEvent = DomainEvent<
  "fulfillment.shipment.packing-line-quantity-set",
  Readonly<{
    shipmentId: ShipmentId;
    lineId: ShipmentLineId;
    confirmedQuantity: number;
    confirmedAt: string | null;
    setAt: string;
  }>
>;

export type ShipmentLabelAttachedEvent = DomainEvent<
  "fulfillment.shipment.label-attached",
  Readonly<{
    shipmentId: ShipmentId;
    shippingMethod: ShippingMethod;
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
    addressOverrideAudit: FulfillmentAddressOverrideAudit | null;
    attachedAt: string;
  }>
>;

export type ShipmentLabelPurchaseFailedEvent = DomainEvent<
  "fulfillment.shipment.label-purchase-failed",
  Readonly<{
    shipmentId: ShipmentId;
    postageProviderName: string;
    postageProviderMode: string;
    errorCode: string | null;
    errorMessage: string;
    failedAt: string;
  }>
>;

export type ShipmentLabelVoidedEvent = DomainEvent<
  "fulfillment.shipment.label-voided",
  Readonly<{
    shipmentId: ShipmentId;
    refundStatus: string;
    refundReference: string | null;
    voidedAt: string;
  }>
>;

export type ShipmentLabelRefundStatusRecordedEvent = DomainEvent<
  "fulfillment.shipment.label-refund-status-recorded",
  Readonly<{
    shipmentId: ShipmentId;
    refundStatus: string;
    refundReference: string | null;
    resolvedAt: string;
  }>
>;

export type ShipmentCancelledEvent = DomainEvent<
  "fulfillment.shipment.cancelled",
  Readonly<{
    shipmentId: ShipmentId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    cancelledAt: string;
  }>
>;

export type ShipmentDispatchedEvent = DomainEvent<
  "fulfillment.shipment.dispatched",
  Readonly<{
    shipmentId: ShipmentId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    trackingIdentifier: string | null;
    dispatchedAt: string;
  }>
>;

export type ShipmentDeliveredEvent = DomainEvent<
  "fulfillment.shipment.delivered",
  Readonly<{
    shipmentId: ShipmentId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    shippingDestinationSnapshot: AddressSnapshot;
    trackingIdentifier: string | null;
    deliveredAt: string;
  }>
>;

export type ShipmentReturnedEvent = DomainEvent<
  "fulfillment.shipment.returned",
  Readonly<{
    shipmentId: ShipmentId;
    reason: string | null;
    returnedAt: string;
  }>
>;

export type ShipmentExceptionRaisedEvent = DomainEvent<
  "fulfillment.shipment.exception-raised",
  Readonly<{
    shipmentId: ShipmentId;
    exceptionType: ShipmentExceptionType;
    notes: string | null;
    raisedAt: string;
  }>
>;

export type FulfillmentCsatOutcomeFactPublishedEvent = DomainEvent<
  typeof fulfillmentCsatOutcomeFactEventType,
  ReturnType<typeof createFulfillmentCsatOutcomeFact>
>;

export type FulfillmentShipmentEvent =
  | ShipmentCreatedEvent
  | ShipmentPackingStartedEvent
  | ShipmentPackingLineConfirmedEvent
  | ShipmentPackingLineUnconfirmedEvent
  | ShipmentPackingLineQuantitySetEvent
  | ShipmentPackagePreparedEvent
  | ShipmentLabelAttachedEvent
  | ShipmentLabelPurchaseFailedEvent
  | ShipmentLabelVoidedEvent
  | ShipmentLabelRefundStatusRecordedEvent
  | ShipmentCancelledEvent
  | ShipmentDispatchedEvent
  | ShipmentDeliveredEvent
  | ShipmentReturnedEvent
  | ShipmentExceptionRaisedEvent
  | FulfillmentCsatOutcomeFactPublishedEvent;

function normalizeShipmentLines(lines: readonly FulfillmentShipmentLineInput[]) {
  assert(lines.length > 0, "Shipments must include at least one line.");
  return lines.map((line) => {
    const quantity = ensurePositiveInteger(line.quantity, "Shipment line quantity must be a positive whole number.");
    const packingConfirmedAt = line.packingConfirmedAt
      ? ensureIsoTimestamp(line.packingConfirmedAt, "Shipment line packing confirmation must record a timestamp.")
      : null;
    const packingConfirmedQuantity =
      line.packingConfirmedQuantity == null
        ? packingConfirmedAt
          ? quantity
          : 0
        : ensureNonNegativeInteger(
            line.packingConfirmedQuantity,
            "Shipment line packed quantity must be a non-negative whole number.",
          );
    assert(
      packingConfirmedQuantity <= quantity,
      "Shipment line packed quantity cannot exceed the shipment line quantity.",
    );

    return {
      lineId: line.lineId,
      orderLineId: normalizeRequiredText(line.orderLineId, "Shipment lines must reference an order line."),
      catalogItemId: normalizeRequiredText(
        line.catalogItemId,
        "Shipment lines must reference a catalog item.",
      ) as CatalogItemId,
      productId: normalizeRequiredText(line.productId, "Shipment lines must reference a product id.") as ProductKey,
      itemTitle: normalizeRequiredText(line.itemTitle, "Shipment lines must include an item title."),
      itemSubtitle: normalizeOptionalText(line.itemSubtitle),
      productSummary: normalizeOptionalText(line.productSummary),
      quantity,
      packingConfirmedQuantity,
      packingConfirmedAt: packingConfirmedQuantity >= quantity ? packingConfirmedAt : null,
    };
  });
}

export const decideFulfillmentShipment: AggregateDecider<
  FulfillmentShipmentState,
  FulfillmentShipmentCommand,
  FulfillmentShipmentEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateShipment":
      assert(state.shipmentId === null, "Shipment has already been created.");
      return [
        {
          type: "fulfillment.shipment.created",
          data: {
            shipmentId: command.shipmentId,
            orderId: command.orderId,
            buyerAccountId: command.buyerAccountId,
            sellerAccountId: command.sellerAccountId,
            shippingOption: normalizeRequiredText(command.shippingOption, "Shipment must include a shipping option."),
            shippingDestinationSnapshot: normalizeAddressSnapshot(
              command.shippingDestinationSnapshot,
              "Shipping destination",
            ),
            shippingOriginSnapshot: normalizeAddressSnapshot(command.shippingOriginSnapshot, "Shipping origin"),
            shippingPlanSnapshot: command.shippingPlanSnapshot ?? null,
            lines: normalizeShipmentLines(command.lines),
            createdAt: ensureIsoTimestamp(command.createdAt, "Shipment creation must record a timestamp."),
          },
        },
      ];
    case "PrepareShipmentPackage":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.packageStatus === "packed") {
        return [];
      }
      assert(
        state.status === "awaiting-package" || state.status === "packing",
        "Only shipments awaiting package preparation or in packing can be packed.",
      );
      assert(
        state.lines.every((line) => line.packingConfirmedQuantity === line.quantity),
        "Every shipment line must be confirmed before the package can be packed.",
      );
      return [
        {
          type: "fulfillment.shipment.package-prepared",
          data: {
            shipmentId: state.shipmentId,
            packageCount: ensurePositiveInteger(command.packageCount, "Package count must be a positive whole number."),
            preparedAt: ensureIsoTimestamp(command.preparedAt, "Package preparation must record a timestamp."),
          },
        },
      ];
    case "StartShipmentPacking":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.orderId !== null, "Shipment must reference an order before packing starts.");
      assert(state.buyerAccountId !== null, "Shipment must reference a buyer before packing starts.");
      assert(state.sellerAccountId !== null, "Shipment must reference a seller before packing starts.");
      if (state.status === "packing") {
        return [];
      }
      assert(state.status === "awaiting-package", "Only shipments awaiting package preparation can start packing.");
      return [
        {
          type: "fulfillment.shipment.packing-started",
          data: {
            shipmentId: state.shipmentId,
            orderId: state.orderId,
            buyerAccountId: state.buyerAccountId,
            sellerAccountId: state.sellerAccountId,
            startedAt: ensureIsoTimestamp(command.startedAt, "Packing start must record a timestamp."),
          },
        },
      ];
    case "ConfirmShipmentPackingLine": {
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.status === "packing", "Only shipments in packing can confirm packed lines.");
      const line = state.lines.find((candidate) => candidate.lineId === command.lineId);
      assert(line, "Shipment line must belong to this shipment.");
      if (line.packingConfirmedQuantity === line.quantity) {
        return [];
      }
      return [
        {
          type: "fulfillment.shipment.packing-line-confirmed",
          data: {
            shipmentId: state.shipmentId,
            lineId: command.lineId,
            confirmedAt: ensureIsoTimestamp(command.confirmedAt, "Line confirmation must record a timestamp."),
          },
        },
      ];
    }
    case "SetShipmentPackingLineQuantity": {
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.status === "packing", "Only shipments in packing can update packed line quantities.");
      const line = state.lines.find((candidate) => candidate.lineId === command.lineId);
      assert(line, "Shipment line must belong to this shipment.");
      const confirmedQuantity = ensureNonNegativeInteger(
        command.confirmedQuantity,
        "Packed quantity must be a non-negative whole number.",
      );
      assert(confirmedQuantity <= line.quantity, "Packed quantity cannot exceed the shipment line quantity.");
      if (line.packingConfirmedQuantity === confirmedQuantity) {
        return [];
      }
      const setAt = ensureIsoTimestamp(command.setAt, "Packed quantity update must record a timestamp.");
      return [
        {
          type: "fulfillment.shipment.packing-line-quantity-set",
          data: {
            shipmentId: state.shipmentId,
            lineId: command.lineId,
            confirmedQuantity,
            confirmedAt: confirmedQuantity >= line.quantity ? setAt : null,
            setAt,
          },
        },
      ];
    }
    case "UnconfirmShipmentPackingLine": {
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.status === "packing", "Only shipments in packing can clear packed line confirmations.");
      const line = state.lines.find((candidate) => candidate.lineId === command.lineId);
      assert(line, "Shipment line must belong to this shipment.");
      if (line.packingConfirmedQuantity === 0) {
        return [];
      }
      return [
        {
          type: "fulfillment.shipment.packing-line-unconfirmed",
          data: {
            shipmentId: state.shipmentId,
            lineId: command.lineId,
            unconfirmedAt: ensureIsoTimestamp(
              command.unconfirmedAt,
              "Line confirmation removal must record a timestamp.",
            ),
          },
        },
      ];
    }
    case "AttachShipmentLabel":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.packageStatus === "packed", "Shipments must be packed before a label can be attached.");
      assert(state.status === "awaiting-label", "Only shipments awaiting a label can attach one.");
      assert(command.postageAmountCents != null, "Postage amount must be known before a label can be attached.");
      return [
        {
          type: "fulfillment.shipment.label-attached",
          data: {
            shipmentId: state.shipmentId,
            shippingMethod: normalizeShippingMethod(command.shippingMethod),
            carrierName: normalizeRequiredText(command.carrierName, "Carrier name is required."),
            labelReference: normalizeRequiredText(command.labelReference, "Label reference is required."),
            labelDocumentUrl: normalizeOptionalText(command.labelDocumentUrl),
            trackingIdentifier: normalizeRequiredText(command.trackingIdentifier, "Tracking identifier is required."),
            postageProviderName: normalizeOptionalText(command.postageProviderName),
            postageProviderMode: normalizeOptionalText(command.postageProviderMode),
            postageProviderShipmentId: normalizeOptionalText(command.postageProviderShipmentId),
            postageProviderLabelId: normalizeOptionalText(command.postageProviderLabelId),
            postageRateId: normalizeOptionalText(command.postageRateId),
            postageServiceLevel: normalizeOptionalText(command.postageServiceLevel),
            postageAmountCents: ensureNonNegativeInteger(
              command.postageAmountCents,
              "Postage amount must be a known non-negative whole number of cents.",
            ),
            postageCurrency: normalizeRequiredText(command.postageCurrency ?? "", "Postage currency is required."),
            addressOverrideAudit: command.addressOverrideAudit
              ? {
                  originalSenderSnapshot: normalizeAddressSnapshot(
                    command.addressOverrideAudit.originalSenderSnapshot,
                    "Original sender snapshot",
                  ),
                  submittedSenderAddress: normalizeAddressSnapshot(
                    command.addressOverrideAudit.submittedSenderAddress,
                    "Submitted sender address",
                  ),
                  originalRecipientSnapshot: normalizeAddressSnapshot(
                    command.addressOverrideAudit.originalRecipientSnapshot,
                    "Original recipient snapshot",
                  ),
                  submittedRecipientAddress: normalizeAddressSnapshot(
                    command.addressOverrideAudit.submittedRecipientAddress,
                    "Submitted recipient address",
                  ),
                  changedSide: command.addressOverrideAudit.changedSide,
                  reason: normalizeRequiredText(
                    command.addressOverrideAudit.reason,
                    "Address override reason is required.",
                  ),
                  actor: normalizeRequiredText(
                    command.addressOverrideAudit.actor,
                    "Address override actor is required.",
                  ),
                  timestamp: ensureIsoTimestamp(
                    command.addressOverrideAudit.timestamp,
                    "Address override timestamp is required.",
                  ),
                }
              : null,
            attachedAt: ensureIsoTimestamp(command.attachedAt, "Label attachment must record a timestamp."),
          },
        },
      ];
    case "RecordShipmentLabelPurchaseFailed":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.packageStatus === "packed", "Shipments must be packed before a label can be purchased.");
      assert(state.status === "awaiting-label", "Only shipments awaiting a label can record label purchase errors.");
      return [
        {
          type: "fulfillment.shipment.label-purchase-failed",
          data: {
            shipmentId: state.shipmentId,
            postageProviderName: normalizeRequiredText(
              command.postageProviderName,
              "Postage provider name is required.",
            ),
            postageProviderMode: normalizeRequiredText(
              command.postageProviderMode,
              "Postage provider mode is required.",
            ),
            errorCode: normalizeOptionalText(command.errorCode),
            errorMessage: normalizeRequiredText(command.errorMessage, "Label error message is required."),
            failedAt: ensureIsoTimestamp(command.failedAt, "Label error must record a timestamp."),
          },
        },
      ];
    case "VoidShipmentLabel":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.status === "label-attached", "Only attached labels can be voided before dispatch.");
      assert(state.labelStatus === "purchased", "Only purchased labels can be voided.");
      return [
        {
          type: "fulfillment.shipment.label-voided",
          data: {
            shipmentId: state.shipmentId,
            refundStatus: normalizeRequiredText(command.refundStatus, "Label refund status is required."),
            refundReference: normalizeOptionalText(command.refundReference),
            voidedAt: ensureIsoTimestamp(command.voidedAt, "Label void must record a timestamp."),
          },
        },
      ];
    case "RecordShipmentLabelRefundStatus": {
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.labelStatus === "voided" || state.labelStatus === "void-rejected") {
        return [];
      }
      assert(state.labelStatus === "void-requested", "Only requested label voids can record refund status.");
      const refundStatus = normalizeRequiredText(command.refundStatus, "Label refund status is required.");
      assert(
        refundStatus === "refunded" || refundStatus === "rejected",
        "Label refund status must be refunded or rejected.",
      );
      return [
        {
          type: "fulfillment.shipment.label-refund-status-recorded",
          data: {
            shipmentId: state.shipmentId,
            refundStatus,
            refundReference: normalizeOptionalText(command.refundReference),
            resolvedAt: ensureIsoTimestamp(command.resolvedAt, "Label refund status must record a timestamp."),
          },
        },
      ];
    }
    case "CancelShipment":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.orderId !== null, "Shipment must reference an order before cancellation.");
      assert(state.buyerAccountId !== null, "Shipment must reference a buyer before cancellation.");
      assert(state.sellerAccountId !== null, "Shipment must reference a seller before cancellation.");
      if (state.status === "cancelled") {
        return [];
      }
      assert(state.status === "awaiting-package", "Only shipments awaiting package preparation can be cancelled.");
      return [
        {
          type: "fulfillment.shipment.cancelled",
          data: {
            shipmentId: state.shipmentId,
            orderId: state.orderId,
            buyerAccountId: state.buyerAccountId,
            sellerAccountId: state.sellerAccountId,
            cancelledAt: ensureIsoTimestamp(command.cancelledAt, "Shipment cancellation must record a timestamp."),
          },
        },
      ];
    case "DispatchShipment":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.orderId !== null, "Shipment must reference an order before dispatch.");
      assert(state.buyerAccountId !== null, "Shipment must reference a buyer before dispatch.");
      assert(state.sellerAccountId !== null, "Shipment must reference a seller before dispatch.");
      if (state.status === "dispatched") {
        return [];
      }
      assert(state.status === "label-attached", "Only labeled shipments can be dispatched.");
      return [
        {
          type: "fulfillment.shipment.dispatched",
          data: {
            shipmentId: state.shipmentId,
            orderId: state.orderId,
            buyerAccountId: state.buyerAccountId,
            sellerAccountId: state.sellerAccountId,
            trackingIdentifier: state.trackingIdentifier,
            dispatchedAt: ensureIsoTimestamp(command.dispatchedAt, "Dispatch must record a timestamp."),
          },
        },
      ];
    case "RecordShipmentDelivery":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(state.orderId !== null, "Shipment must reference an order before delivery.");
      assert(state.buyerAccountId !== null, "Shipment must reference a buyer before delivery.");
      assert(state.shippingDestinationSnapshot !== null, "Shipment must include a destination before delivery.");
      if (state.status === "delivered") {
        return [];
      }
      assert(
        state.status === "dispatched" || state.status === "exception",
        "Only dispatched shipments or shipments in exception can be delivered.",
      );
      const deliveredAt = ensureIsoTimestamp(command.deliveredAt, "Delivery must record a timestamp.");
      return [
        {
          type: "fulfillment.shipment.delivered",
          data: {
            shipmentId: state.shipmentId,
            orderId: state.orderId,
            buyerAccountId: state.buyerAccountId,
            shippingDestinationSnapshot: state.shippingDestinationSnapshot,
            trackingIdentifier: state.trackingIdentifier,
            deliveredAt,
          },
        },
        {
          type: fulfillmentCsatOutcomeFactEventType,
          data: createFulfillmentCsatOutcomeFact({
            outcomeCode: "order.delivered",
            subjectAccountId: state.buyerAccountId,
            subjectKind: "buyer",
            subjectEntityType: "order",
            subjectEntityId: state.orderId,
            outcomeOccurredAt: deliveredAt,
            idempotencyKey: `order:${state.orderId}:delivered`,
          }),
        },
      ];
    case "ReturnShipment":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.status === "returned") {
        return [];
      }
      assert(
        state.status === "dispatched" || state.status === "exception",
        "Only dispatched shipments or shipments in exception can be returned.",
      );
      return [
        {
          type: "fulfillment.shipment.returned",
          data: {
            shipmentId: state.shipmentId,
            reason: normalizeOptionalText(command.reason),
            returnedAt: ensureIsoTimestamp(command.returnedAt, "Shipment return must record a timestamp."),
          },
        },
      ];
    case "RaiseShipmentException":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(
        state.status !== "delivered" && state.status !== "returned",
        "Delivered or returned shipments cannot enter exception state.",
      );
      return [
        {
          type: "fulfillment.shipment.exception-raised",
          data: {
            shipmentId: state.shipmentId,
            exceptionType: normalizeShipmentExceptionType(command.exceptionType),
            notes: normalizeOptionalText(command.notes),
            raisedAt: ensureIsoTimestamp(command.raisedAt, "Shipment exception must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveFulfillmentShipment: AggregateEvolver<FulfillmentShipmentState, FulfillmentShipmentEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "fulfillment.shipment.created":
      return {
        shipmentId: event.data.shipmentId,
        orderId: event.data.orderId,
        buyerAccountId: event.data.buyerAccountId,
        sellerAccountId: event.data.sellerAccountId,
        shippingOption: event.data.shippingOption,
        shippingDestinationSnapshot: event.data.shippingDestinationSnapshot,
        shippingOriginSnapshot: event.data.shippingOriginSnapshot,
        shippingPlanSnapshot: event.data.shippingPlanSnapshot,
        shippingMethod: null,
        carrierName: null,
        labelReference: null,
        labelDocumentUrl: null,
        trackingIdentifier: null,
        postageProviderName: null,
        postageProviderMode: null,
        postageProviderShipmentId: null,
        postageProviderLabelId: null,
        postageRateId: null,
        postageServiceLevel: null,
        postageAmountCents: null,
        postageCurrency: null,
        labelStatus: "not-purchased",
        labelErrorCode: null,
        labelErrorMessage: null,
        labelRefundStatus: null,
        labelRefundReference: null,
        status: "awaiting-package",
        packageStatus: "awaiting-package",
        packageCount: null,
        lines: normalizeShipmentLines(event.data.lines),
        exceptions: [],
        addressOverrideAudits: [],
        createdAt: event.data.createdAt,
        packingStartedAt: null,
        packagePreparedAt: null,
        labelAttachedAt: null,
        labelVoidedAt: null,
        cancelledAt: null,
        dispatchedAt: null,
        deliveredAt: null,
        returnedAt: null,
        currentExceptionType: null,
        currentExceptionNotes: null,
        exceptionRaisedAt: null,
      };
    case "fulfillment.shipment.packing-started":
      return {
        ...state,
        status: "packing",
        packageStatus: "packing",
        packingStartedAt: event.data.startedAt,
      };
    case "fulfillment.shipment.packing-line-confirmed":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? { ...line, packingConfirmedQuantity: line.quantity, packingConfirmedAt: event.data.confirmedAt }
            : line,
        ),
      };
    case "fulfillment.shipment.packing-line-unconfirmed":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId ? { ...line, packingConfirmedQuantity: 0, packingConfirmedAt: null } : line,
        ),
      };
    case "fulfillment.shipment.packing-line-quantity-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? {
                ...line,
                packingConfirmedQuantity: event.data.confirmedQuantity,
                packingConfirmedAt: event.data.confirmedAt,
              }
            : line,
        ),
      };
    case "fulfillment.shipment.package-prepared":
      return {
        ...state,
        status: "awaiting-label",
        packageStatus: "packed",
        packageCount: event.data.packageCount,
        packagePreparedAt: event.data.preparedAt,
      };
    case "fulfillment.shipment.label-attached":
      return {
        ...state,
        status: "label-attached",
        shippingMethod: event.data.shippingMethod,
        carrierName: event.data.carrierName,
        labelReference: event.data.labelReference,
        labelDocumentUrl: event.data.labelDocumentUrl,
        trackingIdentifier: event.data.trackingIdentifier,
        postageProviderName: event.data.postageProviderName,
        postageProviderMode: event.data.postageProviderMode,
        postageProviderShipmentId: event.data.postageProviderShipmentId,
        postageProviderLabelId: event.data.postageProviderLabelId,
        postageRateId: event.data.postageRateId,
        postageServiceLevel: event.data.postageServiceLevel,
        postageAmountCents: event.data.postageAmountCents,
        postageCurrency: event.data.postageCurrency,
        labelStatus: "purchased",
        labelErrorCode: null,
        labelErrorMessage: null,
        labelRefundStatus: null,
        labelRefundReference: null,
        labelAttachedAt: event.data.attachedAt,
        labelVoidedAt: null,
        addressOverrideAudits: event.data.addressOverrideAudit
          ? [...state.addressOverrideAudits, event.data.addressOverrideAudit]
          : state.addressOverrideAudits,
      };
    case "fulfillment.shipment.label-purchase-failed":
      return {
        ...state,
        labelStatus: "purchase-error",
        postageProviderName: event.data.postageProviderName,
        postageProviderMode: event.data.postageProviderMode,
        labelErrorCode: event.data.errorCode,
        labelErrorMessage: event.data.errorMessage,
      };
    case "fulfillment.shipment.label-voided":
      return {
        ...state,
        status: shipmentStatusFromRefundStatus(event.data.refundStatus),
        labelStatus: labelStatusFromRefundStatus(event.data.refundStatus),
        labelRefundStatus: event.data.refundStatus,
        labelRefundReference: event.data.refundReference,
        labelVoidedAt: event.data.voidedAt,
      };
    case "fulfillment.shipment.label-refund-status-recorded":
      return {
        ...state,
        status: shipmentStatusFromRefundStatus(event.data.refundStatus),
        labelStatus: labelStatusFromRefundStatus(event.data.refundStatus),
        labelRefundStatus: event.data.refundStatus,
        labelRefundReference: event.data.refundReference,
      };
    case "fulfillment.shipment.cancelled":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.data.cancelledAt,
      };
    case "fulfillment.shipment.dispatched":
      return {
        ...state,
        status: "dispatched",
        dispatchedAt: event.data.dispatchedAt,
      };
    case "fulfillment.shipment.delivered":
      return {
        ...state,
        status: "delivered",
        deliveredAt: event.data.deliveredAt,
        currentExceptionType: null,
        currentExceptionNotes: null,
        exceptionRaisedAt: null,
      };
    case "fulfillment.shipment.returned":
      return {
        ...state,
        status: "returned",
        returnedAt: event.data.returnedAt,
        currentExceptionType: null,
        currentExceptionNotes: event.data.reason,
        exceptionRaisedAt: null,
      };
    case "fulfillment.shipment.exception-raised":
      return {
        ...state,
        status: "exception",
        exceptions: [
          ...state.exceptions,
          {
            exceptionType: event.data.exceptionType,
            notes: event.data.notes,
            raisedAt: event.data.raisedAt,
          },
        ],
        currentExceptionType: event.data.exceptionType,
        currentExceptionNotes: event.data.notes,
        exceptionRaisedAt: event.data.raisedAt,
      };
    case fulfillmentCsatOutcomeFactEventType:
      return state;
    default:
      return assertNever(event);
  }
};

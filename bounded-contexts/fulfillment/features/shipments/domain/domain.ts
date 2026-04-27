import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type {
  AccountId,
  OrderId,
  ShipmentId,
} from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShipmentExceptionType,
  normalizeShippingMethod,
  type PackageStatus,
  type ShipmentExceptionType,
  type ShipmentLineId,
  type ShipmentStatus,
  type ShippingMethod,
} from "./common";

export type FulfillmentShipmentLine = Readonly<{
  lineId: ShipmentLineId;
  orderLineId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  productSummary: string | null;
  quantity: number;
}>;

export type FulfillmentShipmentException = Readonly<{
  exceptionType: ShipmentExceptionType;
  notes: string | null;
  raisedAt: string;
}>;

export type FulfillmentShipmentState = Readonly<{
  shipmentId: ShipmentId | null;
  orderId: OrderId | null;
  buyerAccountId: AccountId | null;
  sellerAccountId: AccountId | null;
  shippingOption: string | null;
  shippingMethod: ShippingMethod | null;
  carrierName: string | null;
  labelReference: string | null;
  trackingIdentifier: string | null;
  status: ShipmentStatus | null;
  packageStatus: PackageStatus | null;
  packageCount: number | null;
  lines: FulfillmentShipmentLine[];
  exceptions: FulfillmentShipmentException[];
  createdAt: string | null;
  packagePreparedAt: string | null;
  labelAttachedAt: string | null;
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
  shippingMethod: null,
  carrierName: null,
  labelReference: null,
  trackingIdentifier: null,
  status: null,
  packageStatus: null,
  packageCount: null,
  lines: [],
  exceptions: [],
  createdAt: null,
  packagePreparedAt: null,
  labelAttachedAt: null,
  dispatchedAt: null,
  deliveredAt: null,
  returnedAt: null,
  currentExceptionType: null,
  currentExceptionNotes: null,
  exceptionRaisedAt: null,
};

export type CreateShipmentCommand = Readonly<{
  type: "CreateShipment";
  shipmentId: ShipmentId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  shippingOption: string;
  lines: readonly FulfillmentShipmentLine[];
  createdAt: string;
}>;

export type PrepareShipmentPackageCommand = Readonly<{
  type: "PrepareShipmentPackage";
  packageCount: number;
  preparedAt: string;
}>;

export type AttachShipmentLabelCommand = Readonly<{
  type: "AttachShipmentLabel";
  shippingMethod: ShippingMethod;
  carrierName: string;
  labelReference: string;
  trackingIdentifier: string;
  attachedAt: string;
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
  | PrepareShipmentPackageCommand
  | AttachShipmentLabelCommand
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

export type ShipmentLabelAttachedEvent = DomainEvent<
  "fulfillment.shipment.label-attached",
  Readonly<{
    shipmentId: ShipmentId;
    shippingMethod: ShippingMethod;
    carrierName: string;
    labelReference: string;
    trackingIdentifier: string;
    attachedAt: string;
  }>
>;

export type ShipmentDispatchedEvent = DomainEvent<
  "fulfillment.shipment.dispatched",
  Readonly<{
    shipmentId: ShipmentId;
    dispatchedAt: string;
  }>
>;

export type ShipmentDeliveredEvent = DomainEvent<
  "fulfillment.shipment.delivered",
  Readonly<{
    shipmentId: ShipmentId;
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

export type FulfillmentShipmentEvent =
  | ShipmentCreatedEvent
  | ShipmentPackagePreparedEvent
  | ShipmentLabelAttachedEvent
  | ShipmentDispatchedEvent
  | ShipmentDeliveredEvent
  | ShipmentReturnedEvent
  | ShipmentExceptionRaisedEvent;

function normalizeShipmentLines(lines: readonly FulfillmentShipmentLine[]) {
  assert(lines.length > 0, "Shipments must include at least one line.");
  return lines.map((line) => ({
    lineId: line.lineId,
    orderLineId: normalizeRequiredText(
      line.orderLineId,
      "Shipment lines must reference an order line.",
    ),
    catalogItemId: normalizeRequiredText(
      line.catalogItemId,
      "Shipment lines must reference a catalog item.",
    ),
    productId: normalizeRequiredText(
      line.productId,
      "Shipment lines must reference a product id.",
    ),
    itemTitle: normalizeRequiredText(
      line.itemTitle,
      "Shipment lines must include an item title.",
    ),
    itemSubtitle: normalizeOptionalText(line.itemSubtitle),
    productSummary: normalizeOptionalText(line.productSummary),
    quantity: ensurePositiveInteger(
      line.quantity,
      "Shipment line quantity must be a positive whole number.",
    ),
  }));
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
            shippingOption: normalizeRequiredText(
              command.shippingOption,
              "Shipment must include a shipping option.",
            ),
            lines: normalizeShipmentLines(command.lines),
            createdAt: ensureIsoTimestamp(
              command.createdAt,
              "Shipment creation must record a timestamp.",
            ),
          },
        },
      ];
    case "PrepareShipmentPackage":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.packageStatus === "packed") {
        return [];
      }
      assert(
        state.status === "awaiting-package",
        "Only shipments awaiting package preparation can be packed.",
      );
      return [
        {
          type: "fulfillment.shipment.package-prepared",
          data: {
            shipmentId: state.shipmentId,
            packageCount: ensurePositiveInteger(
              command.packageCount,
              "Package count must be a positive whole number.",
            ),
            preparedAt: ensureIsoTimestamp(
              command.preparedAt,
              "Package preparation must record a timestamp.",
            ),
          },
        },
      ];
    case "AttachShipmentLabel":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      assert(
        state.packageStatus === "packed",
        "Shipments must be packed before a label can be attached.",
      );
      assert(
        state.status === "awaiting-label",
        "Only shipments awaiting a label can attach one.",
      );
      return [
        {
          type: "fulfillment.shipment.label-attached",
          data: {
            shipmentId: state.shipmentId,
            shippingMethod: normalizeShippingMethod(command.shippingMethod),
            carrierName: normalizeRequiredText(
              command.carrierName,
              "Carrier name is required.",
            ),
            labelReference: normalizeRequiredText(
              command.labelReference,
              "Label reference is required.",
            ),
            trackingIdentifier: normalizeRequiredText(
              command.trackingIdentifier,
              "Tracking identifier is required.",
            ),
            attachedAt: ensureIsoTimestamp(
              command.attachedAt,
              "Label attachment must record a timestamp.",
            ),
          },
        },
      ];
    case "DispatchShipment":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.status === "dispatched") {
        return [];
      }
      assert(
        state.status === "label-attached",
        "Only labeled shipments can be dispatched.",
      );
      return [
        {
          type: "fulfillment.shipment.dispatched",
          data: {
            shipmentId: state.shipmentId,
            dispatchedAt: ensureIsoTimestamp(
              command.dispatchedAt,
              "Dispatch must record a timestamp.",
            ),
          },
        },
      ];
    case "RecordShipmentDelivery":
      assert(state.shipmentId !== null, "Shipment must be created first.");
      if (state.status === "delivered") {
        return [];
      }
      assert(
        state.status === "dispatched" || state.status === "exception",
        "Only dispatched shipments or shipments in exception can be delivered.",
      );
      return [
        {
          type: "fulfillment.shipment.delivered",
          data: {
            shipmentId: state.shipmentId,
            deliveredAt: ensureIsoTimestamp(
              command.deliveredAt,
              "Delivery must record a timestamp.",
            ),
          },
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
            returnedAt: ensureIsoTimestamp(
              command.returnedAt,
              "Shipment return must record a timestamp.",
            ),
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
            raisedAt: ensureIsoTimestamp(
              command.raisedAt,
              "Shipment exception must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveFulfillmentShipment: AggregateEvolver<
  FulfillmentShipmentState,
  FulfillmentShipmentEvent
> = (state, event) => {
  switch (event.type) {
    case "fulfillment.shipment.created":
      return {
        shipmentId: event.data.shipmentId,
        orderId: event.data.orderId,
        buyerAccountId: event.data.buyerAccountId,
        sellerAccountId: event.data.sellerAccountId,
        shippingOption: event.data.shippingOption,
        shippingMethod: null,
        carrierName: null,
        labelReference: null,
        trackingIdentifier: null,
        status: "awaiting-package",
        packageStatus: "awaiting-package",
        packageCount: null,
        lines: event.data.lines,
        exceptions: [],
        createdAt: event.data.createdAt,
        packagePreparedAt: null,
        labelAttachedAt: null,
        dispatchedAt: null,
        deliveredAt: null,
        returnedAt: null,
        currentExceptionType: null,
        currentExceptionNotes: null,
        exceptionRaisedAt: null,
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
        trackingIdentifier: event.data.trackingIdentifier,
        labelAttachedAt: event.data.attachedAt,
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
    default:
      return assertNever(event);
  }
};

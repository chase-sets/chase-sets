import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { CatalogVersionKey } from "@chase-sets/catalog/integration";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShippingOption,
  normalizeVersionSelection,
  type OrderLineId,
  type OrderSourceType,
  type OrderStatus,
  type ShippingOption,
  type VersionSelectionEntry,
} from "../common";

export type OrderingOrderLine = Readonly<{
  lineId: OrderLineId;
  listingId: string;
  inventoryRecordId: string;
  catalogItemId: string;
  catalogVersionKey: CatalogVersionKey;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: VersionSelectionEntry[];
  versionSummary: string | null;
  unitPriceAmount: string;
  quantity: number;
  lineTotalAmount: string;
}>;

export type OrderingInventoryReservation = Readonly<{
  holdId: string;
  inventoryRecordId: string;
  sellerAccountId: string;
  quantity: number;
}>;

export type OrderingOrderState = Readonly<{
  orderId: OrderId | null;
  sourceType: OrderSourceType | null;
  sourceReferenceId: string | null;
  buyerAccountId: AccountId | null;
  sellerAccountId: AccountId | null;
  shippingOption: ShippingOption | null;
  itemSubtotalAmount: string | null;
  shippingBaseAmount: string | null;
  shippingDiscountAmount: string | null;
  shippingChargeAmount: string | null;
  totalAmount: string | null;
  lines: OrderingOrderLine[];
  inventoryReservations: OrderingInventoryReservation[];
  status: OrderStatus | null;
  cancelledAt: string | null;
  readyForFulfillmentAt: string | null;
}>;

export const initialOrderingOrderState: OrderingOrderState = {
  orderId: null,
  sourceType: null,
  sourceReferenceId: null,
  buyerAccountId: null,
  sellerAccountId: null,
  shippingOption: null,
  itemSubtotalAmount: null,
  shippingBaseAmount: null,
  shippingDiscountAmount: null,
  shippingChargeAmount: null,
  totalAmount: null,
  lines: [],
  inventoryReservations: [],
  status: null,
  cancelledAt: null,
  readyForFulfillmentAt: null,
};

export type CreateOrderCommand = Readonly<{
  type: "CreateOrder";
  orderId: OrderId;
  sourceType: OrderSourceType;
  sourceReferenceId: string | null;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingChargeAmount: string;
  totalAmount: string;
  lines: OrderingOrderLine[];
  inventoryReservations: OrderingInventoryReservation[];
}>;

export type CancelOrderCommand = Readonly<{
  type: "CancelOrder";
  cancelledAt: string;
}>;

export type MarkReadyForFulfillmentCommand = Readonly<{
  type: "MarkReadyForFulfillment";
  readyForFulfillmentAt: string;
}>;

export type OrderingOrderCommand =
  | CreateOrderCommand
  | CancelOrderCommand
  | MarkReadyForFulfillmentCommand;

export type OrderCreatedEvent = DomainEvent<
  "ordering.order.created",
  Readonly<{
    orderId: OrderId;
    sourceType: OrderSourceType;
    sourceReferenceId: string | null;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    shippingOption: ShippingOption;
    itemSubtotalAmount: string;
    shippingBaseAmount: string;
    shippingDiscountAmount: string;
    shippingChargeAmount: string;
    totalAmount: string;
    lines: OrderingOrderLine[];
    inventoryReservations: OrderingInventoryReservation[];
  }>
>;

export type OrderCancelledEvent = DomainEvent<
  "ordering.order.cancelled",
  Readonly<{
    orderId: OrderId;
    cancelledAt: string;
  }>
>;

export type OrderReadyForFulfillmentEvent = DomainEvent<
  "ordering.order.ready-for-fulfillment-recorded",
  Readonly<{
    orderId: OrderId;
    readyForFulfillmentAt: string;
  }>
>;

export type OrderingOrderEvent =
  | OrderCreatedEvent
  | OrderCancelledEvent
  | OrderReadyForFulfillmentEvent;

function normalizeOrderLines(lines: readonly OrderingOrderLine[]) {
  assert(lines.length > 0, "Orders must include at least one line.");
  return lines.map((line) => ({
    lineId: line.lineId,
    listingId: normalizeRequiredText(line.listingId, "Order lines must reference a listing."),
    inventoryRecordId: normalizeRequiredText(
      line.inventoryRecordId,
      "Order lines must reference inventory.",
    ),
    catalogItemId: normalizeRequiredText(
      line.catalogItemId,
      "Order lines must reference a catalog item.",
    ),
    catalogVersionKey: normalizeRequiredText(
      String(line.catalogVersionKey),
      "Order lines must reference a catalog version key.",
    ) as CatalogVersionKey,
    itemTitle: normalizeRequiredText(
      line.itemTitle,
      "Order lines must include an item title snapshot.",
    ),
    itemSubtitle: normalizeOptionalText(line.itemSubtitle),
    versionSelection: normalizeVersionSelection(line.versionSelection),
    versionSummary: normalizeOptionalText(line.versionSummary),
    unitPriceAmount: normalizeMoneyAmount(line.unitPriceAmount, {
      fieldName: "Unit price",
    }),
    quantity: ensurePositiveInteger(
      line.quantity,
      "Order line quantity must be a positive whole number.",
    ),
    lineTotalAmount: normalizeMoneyAmount(line.lineTotalAmount, {
      fieldName: "Line total",
    }),
  }));
}

function normalizeReservations(
  reservations: readonly OrderingInventoryReservation[],
  sellerAccountId: string,
) {
  assert(
    reservations.length > 0,
    "Orders must include inventory reservations for committed quantity.",
  );
  return reservations.map((reservation) => ({
    holdId: normalizeRequiredText(
      reservation.holdId,
      "Inventory reservations must include a hold id.",
    ),
    inventoryRecordId: normalizeRequiredText(
      reservation.inventoryRecordId,
      "Inventory reservations must include a record id.",
    ),
    sellerAccountId: normalizeRequiredText(
      reservation.sellerAccountId,
      "Inventory reservations must include a seller account id.",
    ),
    quantity: ensurePositiveInteger(
      reservation.quantity,
      "Inventory reservation quantity must be a positive whole number.",
    ),
  })).map((reservation) => {
    assert(
      reservation.sellerAccountId === sellerAccountId,
      "Inventory reservations must belong to the committed seller.",
    );
    return reservation;
  });
}

export const decideOrderingOrder: AggregateDecider<
  OrderingOrderState,
  OrderingOrderCommand,
  OrderingOrderEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateOrder": {
      assert(state.orderId === null, "Order has already been created.");
      const normalizedLines = normalizeOrderLines(command.lines);
      const normalizedSellerAccountId = normalizeRequiredText(
        command.sellerAccountId,
        "Orders must include a seller account.",
      );
      return [
        {
          type: "ordering.order.created",
          data: {
            orderId: command.orderId,
            sourceType: command.sourceType,
            sourceReferenceId: normalizeOptionalText(command.sourceReferenceId),
            buyerAccountId: command.buyerAccountId,
            sellerAccountId: normalizedSellerAccountId as AccountId,
            shippingOption: normalizeShippingOption(command.shippingOption),
            itemSubtotalAmount: normalizeMoneyAmount(command.itemSubtotalAmount, {
              fieldName: "Item subtotal",
              allowZero: true,
            }),
            shippingBaseAmount: normalizeMoneyAmount(command.shippingBaseAmount, {
              fieldName: "Shipping base amount",
              allowZero: true,
            }),
            shippingDiscountAmount: normalizeMoneyAmount(command.shippingDiscountAmount, {
              fieldName: "Shipping discount amount",
              allowZero: true,
            }),
            shippingChargeAmount: normalizeMoneyAmount(command.shippingChargeAmount, {
              fieldName: "Shipping charge amount",
              allowZero: true,
            }),
            totalAmount: normalizeMoneyAmount(command.totalAmount, {
              fieldName: "Order total",
              allowZero: true,
            }),
            lines: normalizedLines,
            inventoryReservations: normalizeReservations(
              command.inventoryReservations,
              normalizedSellerAccountId,
            ),
          },
        },
      ];
    }
    case "CancelOrder":
      assert(state.orderId !== null, "Order must be created first.");
      assert(state.status === "pending-payment", "Only pending orders can be cancelled.");
      return [
        {
          type: "ordering.order.cancelled",
          data: {
            orderId: state.orderId,
            cancelledAt: normalizeRequiredText(
              command.cancelledAt,
              "Order cancellation must record a timestamp.",
            ),
          },
        },
      ];
    case "MarkReadyForFulfillment":
      assert(state.orderId !== null, "Order must be created first.");
      if (state.status === "ready-for-fulfillment") {
        return [];
      }
      assert(
        state.status === "pending-payment",
        "Only pending orders can become ready for fulfillment.",
      );
      return [
        {
          type: "ordering.order.ready-for-fulfillment-recorded",
          data: {
            orderId: state.orderId,
            readyForFulfillmentAt: normalizeRequiredText(
              command.readyForFulfillmentAt,
              "Order readiness must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveOrderingOrder: AggregateEvolver<
  OrderingOrderState,
  OrderingOrderEvent
> = (state, event) => {
  switch (event.type) {
    case "ordering.order.created":
      return {
        orderId: event.data.orderId,
        sourceType: event.data.sourceType,
        sourceReferenceId: event.data.sourceReferenceId,
        buyerAccountId: event.data.buyerAccountId,
        sellerAccountId: event.data.sellerAccountId,
        shippingOption: event.data.shippingOption,
        itemSubtotalAmount: event.data.itemSubtotalAmount,
        shippingBaseAmount: event.data.shippingBaseAmount,
        shippingDiscountAmount: event.data.shippingDiscountAmount,
        shippingChargeAmount: event.data.shippingChargeAmount,
        totalAmount: event.data.totalAmount,
        lines: event.data.lines,
        inventoryReservations: event.data.inventoryReservations,
        status: "pending-payment",
        cancelledAt: null,
        readyForFulfillmentAt: null,
      };
    case "ordering.order.cancelled":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.data.cancelledAt,
      };
    case "ordering.order.ready-for-fulfillment-recorded":
      return {
        ...state,
        status: "ready-for-fulfillment",
        readyForFulfillmentAt: event.data.readyForFulfillmentAt,
      };
    default:
      return assertNever(event);
  }
};


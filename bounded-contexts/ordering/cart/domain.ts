import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CatalogVersionKey } from "@chase-sets/catalog/integration";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeVersionSelection,
  type CartLineId,
  type VersionSelectionEntry,
} from "../common";

export type OrderingCartLine = Readonly<{
  lineId: CartLineId;
  catalogItemId: string;
  catalogVersionKey: CatalogVersionKey;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  quantity: number;
}>;

export type OrderingCartState = Readonly<{
  buyerAccountId: AccountId | null;
  lines: readonly OrderingCartLine[];
  lastCheckedOutAt: string | null;
}>;

export const initialOrderingCartState: OrderingCartState = {
  buyerAccountId: null,
  lines: [],
  lastCheckedOutAt: null,
};

export type AddCartLineCommand = Readonly<{
  type: "AddCartLine";
  buyerAccountId: AccountId;
  lineId: CartLineId;
  catalogItemId: string;
  catalogVersionKey: CatalogVersionKey;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  quantity: number;
}>;

export type SetCartLineQuantityCommand = Readonly<{
  type: "SetCartLineQuantity";
  lineId: CartLineId;
  quantity: number;
}>;

export type RemoveCartLineCommand = Readonly<{
  type: "RemoveCartLine";
  lineId: CartLineId;
}>;

export type CheckoutCartCommand = Readonly<{
  type: "CheckoutCart";
  checkedOutAt: string;
}>;

export type OrderingCartCommand =
  | AddCartLineCommand
  | SetCartLineQuantityCommand
  | RemoveCartLineCommand
  | CheckoutCartCommand;

export type CartLineAddedEvent = DomainEvent<
  "ordering.cart.line-added",
  Readonly<{
    buyerAccountId: AccountId;
    lineId: CartLineId;
    catalogItemId: string;
    catalogVersionKey: CatalogVersionKey;
    itemTitle: string;
    itemSubtitle: string | null;
    versionSelection: VersionSelectionEntry[];
    versionSummary: string | null;
    quantity: number;
  }>
>;

export type CartLineQuantitySetEvent = DomainEvent<
  "ordering.cart.line-quantity-set",
  Readonly<{
    lineId: CartLineId;
    quantity: number;
  }>
>;

export type CartLineRemovedEvent = DomainEvent<
  "ordering.cart.line-removed",
  Readonly<{
    lineId: CartLineId;
  }>
>;

export type CartCheckedOutEvent = DomainEvent<
  "ordering.cart.checked-out",
  Readonly<{
    buyerAccountId: AccountId;
    checkedOutAt: string;
  }>
>;

export type OrderingCartEvent =
  | CartLineAddedEvent
  | CartLineQuantitySetEvent
  | CartLineRemovedEvent
  | CartCheckedOutEvent;

function requireCartLine(state: OrderingCartState, lineId: CartLineId) {
  const line = state.lines.find((entry) => entry.lineId === lineId);
  assert(line, "Cart line not found.");
  return line;
}

export const decideOrderingCart: AggregateDecider<
  OrderingCartState,
  OrderingCartCommand,
  OrderingCartEvent
> = (state, command) => {
  switch (command.type) {
    case "AddCartLine":
      assert(
        state.buyerAccountId === null || state.buyerAccountId === command.buyerAccountId,
        "Cart is owned by a different buyer account.",
      );
      assert(
        !state.lines.some((line) => line.lineId === command.lineId),
        "Cart line has already been added.",
      );
      return [
        {
          type: "ordering.cart.line-added",
          data: {
            buyerAccountId: command.buyerAccountId,
            lineId: command.lineId,
            catalogItemId: normalizeRequiredText(
              command.catalogItemId,
              "Cart lines must reference a catalog item.",
            ),
            catalogVersionKey: normalizeRequiredText(
              String(command.catalogVersionKey),
              "Cart lines must reference a catalog version key.",
            ) as CatalogVersionKey,
            itemTitle: normalizeRequiredText(
              command.itemTitle,
              "Cart lines must include an item title snapshot.",
            ),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            versionSelection: normalizeVersionSelection(command.versionSelection),
            versionSummary: normalizeOptionalText(command.versionSummary),
            quantity: ensurePositiveInteger(
              command.quantity,
              "Cart quantity must be a positive whole number.",
            ),
          },
        },
      ];
    case "SetCartLineQuantity":
      requireCartLine(state, command.lineId);
      return [
        {
          type: "ordering.cart.line-quantity-set",
          data: {
            lineId: command.lineId,
            quantity: ensurePositiveInteger(
              command.quantity,
              "Cart quantity must be a positive whole number.",
            ),
          },
        },
      ];
    case "RemoveCartLine":
      requireCartLine(state, command.lineId);
      return [
        {
          type: "ordering.cart.line-removed",
          data: {
            lineId: command.lineId,
          },
        },
      ];
    case "CheckoutCart":
      assert(state.buyerAccountId !== null, "Cart has not been initialized.");
      assert(state.lines.length > 0, "Cart must contain at least one line.");
      return [
        {
          type: "ordering.cart.checked-out",
          data: {
            buyerAccountId: state.buyerAccountId,
            checkedOutAt: normalizeRequiredText(
              command.checkedOutAt,
              "Checkout must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveOrderingCart: AggregateEvolver<
  OrderingCartState,
  OrderingCartEvent
> = (state, event) => {
  switch (event.type) {
    case "ordering.cart.line-added":
      return {
        buyerAccountId: event.data.buyerAccountId,
        lines: [
          ...state.lines,
          {
            lineId: event.data.lineId,
            catalogItemId: event.data.catalogItemId,
            catalogVersionKey: event.data.catalogVersionKey,
            itemTitle: event.data.itemTitle,
            itemSubtitle: event.data.itemSubtitle,
            versionSelection: event.data.versionSelection,
            versionSummary: event.data.versionSummary,
            quantity: event.data.quantity,
          },
        ],
        lastCheckedOutAt: state.lastCheckedOutAt,
      };
    case "ordering.cart.line-quantity-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? { ...line, quantity: event.data.quantity }
            : line,
        ),
      };
    case "ordering.cart.line-removed":
      return {
        ...state,
        lines: state.lines.filter((line) => line.lineId !== event.data.lineId),
      };
    case "ordering.cart.checked-out":
      return {
        buyerAccountId: event.data.buyerAccountId,
        lines: [],
        lastCheckedOutAt: event.data.checkedOutAt,
      };
    default:
      return assertNever(event);
  }
};


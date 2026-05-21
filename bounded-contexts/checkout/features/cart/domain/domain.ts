import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeVersionSelection,
  type CartLineId,
  type VersionSelectedOptionEntry,
} from "../../../support/runtime-support/common";

export type CheckoutCartLine = Readonly<{
  lineId: CartLineId;
  catalogItemId: string;
  productId: string;
  itemLanguageCode: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemImageUrl: string | null;
  itemImageLoadingUrl: string | null;
  itemImageLoadingAlt: string | null;
  itemImageLoadingSrcSet: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId: string | null;
  sellerPreferenceId: string | null;
  availabilityState: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type CheckoutCartState = Readonly<{
  buyerAccountId: AccountId | null;
  lines: readonly CheckoutCartLine[];
  lastCheckedOutAt: string | null;
}>;

export const initialCheckoutCartState: CheckoutCartState = {
  buyerAccountId: null,
  lines: [],
  lastCheckedOutAt: null,
};

export type AddCartLineCommand = Readonly<{
  type: "AddCartLine";
  buyerAccountId: AccountId;
  lineId: CartLineId;
  catalogItemId: string;
  productId: string;
  itemLanguageCode?: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemImageUrl: string | null;
  itemImageLoadingUrl?: string | null;
  itemImageLoadingAlt?: string | null;
  itemImageLoadingSrcSet?: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type SetCartLineQuantityCommand = Readonly<{
  type: "SetCartLineQuantity";
  lineId: CartLineId;
  quantity: number;
}>;

export type SetCartLineFulfillmentCommand = Readonly<{
  type: "SetCartLineFulfillment";
  lineId: CartLineId;
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type RemoveCartLineCommand = Readonly<{
  type: "RemoveCartLine";
  lineId: CartLineId;
}>;

export type ClearCartCommand = Readonly<{
  type: "CheckoutCart";
  checkedOutAt: string;
}>;

export type CheckoutCartCommand =
  | AddCartLineCommand
  | SetCartLineQuantityCommand
  | SetCartLineFulfillmentCommand
  | RemoveCartLineCommand
  | ClearCartCommand;

export type CartLineAddedEvent = DomainEvent<
  "checkout.cart.line-added",
  Readonly<{
    buyerAccountId: AccountId;
    lineId: CartLineId;
    catalogItemId: string;
    productId: string;
    itemLanguageCode: string | null;
    itemTitle: string;
    itemSubtitle: string | null;
    itemImageUrl: string | null;
    itemImageLoadingUrl?: string | null;
    itemImageLoadingAlt?: string | null;
    itemImageLoadingSrcSet?: string | null;
    selectedOptions: VersionSelectedOptionEntry[];
    productSummary: string | null;
    quantity: number;
    fulfillmentMode?: "optimize" | "locked-listing";
    lockedListingId?: string | null;
    sellerPreferenceId?: string | null;
    availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
  }>
>;

export type CartLineQuantitySetEvent = DomainEvent<
  "checkout.cart.line-quantity-set",
  Readonly<{
    lineId: CartLineId;
    quantity: number;
  }>
>;

export type CartLineFulfillmentSetEvent = DomainEvent<
  "checkout.cart.line-fulfillment-set",
  Readonly<{
    lineId: CartLineId;
    fulfillmentMode: "optimize" | "locked-listing";
    lockedListingId: string | null;
    sellerPreferenceId: string | null;
    availabilityState: "available" | "unavailable" | "changed" | "waiting-for-supply";
  }>
>;

export type CartLineRemovedEvent = DomainEvent<
  "checkout.cart.line-removed",
  Readonly<{
    lineId: CartLineId;
  }>
>;

export type CartCheckedOutEvent = DomainEvent<
  "checkout.cart.checked-out",
  Readonly<{
    buyerAccountId: AccountId;
    checkedOutAt: string;
  }>
>;

export type CheckoutCartEvent =
  | CartLineAddedEvent
  | CartLineQuantitySetEvent
  | CartLineFulfillmentSetEvent
  | CartLineRemovedEvent
  | CartCheckedOutEvent;

function requireCartLine(state: CheckoutCartState, lineId: CartLineId) {
  const line = state.lines.find((entry) => entry.lineId === lineId);
  assert(line, "Cart line not found.");
  return line;
}

function normalizeFulfillmentMode(
  value: "optimize" | "locked-listing" | undefined,
  lockedListingId: string | null | undefined,
) {
  return value === "locked-listing" || normalizeOptionalText(lockedListingId) ? "locked-listing" : "optimize";
}

function normalizeAvailabilityState(value: "available" | "unavailable" | "changed" | "waiting-for-supply" | undefined) {
  switch (value) {
    case "unavailable":
    case "changed":
    case "waiting-for-supply":
      return value;
    default:
      return "available";
  }
}

export const decideCheckoutCart: AggregateDecider<CheckoutCartState, CheckoutCartCommand, CheckoutCartEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "AddCartLine":
      assert(
        state.buyerAccountId === null || state.buyerAccountId === command.buyerAccountId,
        "Cart is owned by a different account.",
      );
      assert(!state.lines.some((line) => line.lineId === command.lineId), "Cart line has already been added.");
      return [
        {
          type: "checkout.cart.line-added",
          data: {
            buyerAccountId: command.buyerAccountId,
            lineId: command.lineId,
            catalogItemId: normalizeRequiredText(command.catalogItemId, "Cart lines must reference a catalog item."),
            productId: normalizeRequiredText(String(command.productId), "Cart lines must reference a product id."),
            itemLanguageCode: normalizeOptionalText(command.itemLanguageCode ?? null),
            itemTitle: normalizeRequiredText(command.itemTitle, "Cart lines must include an item title snapshot."),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            itemImageUrl: normalizeOptionalText(command.itemImageUrl),
            itemImageLoadingUrl: normalizeOptionalText(command.itemImageLoadingUrl),
            itemImageLoadingAlt: normalizeOptionalText(command.itemImageLoadingAlt),
            itemImageLoadingSrcSet: normalizeOptionalText(command.itemImageLoadingSrcSet),
            selectedOptions: normalizeVersionSelection(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            quantity: ensurePositiveInteger(command.quantity, "Cart quantity must be a positive whole number."),
            fulfillmentMode: normalizeFulfillmentMode(command.fulfillmentMode, command.lockedListingId),
            lockedListingId: normalizeOptionalText(command.lockedListingId),
            sellerPreferenceId: normalizeOptionalText(command.sellerPreferenceId),
            availabilityState: normalizeAvailabilityState(command.availabilityState),
          },
        },
      ];
    case "SetCartLineQuantity":
      requireCartLine(state, command.lineId);
      return [
        {
          type: "checkout.cart.line-quantity-set",
          data: {
            lineId: command.lineId,
            quantity: ensurePositiveInteger(command.quantity, "Cart quantity must be a positive whole number."),
          },
        },
      ];
    case "SetCartLineFulfillment": {
      requireCartLine(state, command.lineId);
      const lockedListingId = normalizeOptionalText(command.lockedListingId);
      const fulfillmentMode = normalizeFulfillmentMode(command.fulfillmentMode, lockedListingId);
      assert(fulfillmentMode === "optimize" || Boolean(lockedListingId), "Locked cart lines must reference a listing.");
      return [
        {
          type: "checkout.cart.line-fulfillment-set",
          data: {
            lineId: command.lineId,
            fulfillmentMode,
            lockedListingId: fulfillmentMode === "locked-listing" ? lockedListingId : null,
            sellerPreferenceId: normalizeOptionalText(command.sellerPreferenceId),
            availabilityState: normalizeAvailabilityState(command.availabilityState),
          },
        },
      ];
    }
    case "RemoveCartLine":
      requireCartLine(state, command.lineId);
      return [
        {
          type: "checkout.cart.line-removed",
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
          type: "checkout.cart.checked-out",
          data: {
            buyerAccountId: state.buyerAccountId,
            checkedOutAt: normalizeRequiredText(command.checkedOutAt, "Checkout must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCheckoutCart: AggregateEvolver<CheckoutCartState, CheckoutCartEvent> = (state, event) => {
  switch (event.type) {
    case "checkout.cart.line-added":
      return {
        buyerAccountId: event.data.buyerAccountId,
        lines: [
          ...state.lines,
          {
            lineId: event.data.lineId,
            catalogItemId: event.data.catalogItemId,
            productId: event.data.productId,
            itemLanguageCode: event.data.itemLanguageCode,
            itemTitle: event.data.itemTitle,
            itemSubtitle: event.data.itemSubtitle,
            itemImageUrl: event.data.itemImageUrl,
            itemImageLoadingUrl: normalizeOptionalText(event.data.itemImageLoadingUrl),
            itemImageLoadingAlt: normalizeOptionalText(event.data.itemImageLoadingAlt),
            itemImageLoadingSrcSet: normalizeOptionalText(event.data.itemImageLoadingSrcSet),
            selectedOptions: event.data.selectedOptions,
            productSummary: event.data.productSummary,
            quantity: event.data.quantity,
            fulfillmentMode: normalizeFulfillmentMode(event.data.fulfillmentMode, event.data.lockedListingId),
            lockedListingId: normalizeOptionalText(event.data.lockedListingId),
            sellerPreferenceId: normalizeOptionalText(event.data.sellerPreferenceId),
            availabilityState: normalizeAvailabilityState(event.data.availabilityState),
          },
        ],
        lastCheckedOutAt: state.lastCheckedOutAt,
      };
    case "checkout.cart.line-quantity-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId ? { ...line, quantity: event.data.quantity } : line,
        ),
      };
    case "checkout.cart.line-fulfillment-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? {
                ...line,
                fulfillmentMode: event.data.fulfillmentMode,
                lockedListingId: event.data.lockedListingId,
                sellerPreferenceId: event.data.sellerPreferenceId,
                availabilityState: event.data.availabilityState,
              }
            : line,
        ),
      };
    case "checkout.cart.line-removed":
      return {
        ...state,
        lines: state.lines.filter((line) => line.lineId !== event.data.lineId),
      };
    case "checkout.cart.checked-out":
      return {
        buyerAccountId: event.data.buyerAccountId,
        lines: [],
        lastCheckedOutAt: event.data.checkedOutAt,
      };
    default:
      return assertNever(event);
  }
};

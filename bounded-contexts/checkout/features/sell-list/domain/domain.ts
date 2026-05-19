import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeVersionSelection,
  type SellListLineId,
  type VersionSelectedOptionEntry,
} from "../../../support/runtime-support/common";

export type CheckoutSellListLine = Readonly<{
  lineId: SellListLineId;
  sellerAccountId: AccountId;
  lineType: "selected-offer" | "product";
  offerId: string | null;
  buyerAccountId: string | null;
  buyerDisplayName: string | null;
  offerPriceAmount: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fallbackMode: "none" | "create-listing";
  minimumListingPriceAmount: string | null;
}>;

export type CheckoutSellListState = Readonly<{
  sellerAccountId: AccountId | null;
  lines: readonly CheckoutSellListLine[];
  lastCheckedOutAt: string | null;
}>;

export const initialCheckoutSellListState: CheckoutSellListState = {
  sellerAccountId: null,
  lines: [],
  lastCheckedOutAt: null,
};

export type AddSellListLineCommand = Readonly<Omit<CheckoutSellListLine, "lineId"> & {
  type: "AddSellListLine";
  lineId: SellListLineId;
}>;

export type RemoveSellListLineCommand = Readonly<{
  type: "RemoveSellListLine";
  lineId: SellListLineId;
}>;

export type SetSellListLineQuantityCommand = Readonly<{
  type: "SetSellListLineQuantity";
  lineId: SellListLineId;
  quantity: number;
}>;

export type CheckoutSellListCommand =
  | AddSellListLineCommand
  | SetSellListLineQuantityCommand
  | RemoveSellListLineCommand
  | Readonly<{ type: "CheckoutSellList"; checkedOutAt: string }>;

export type SellListLineAddedEvent = DomainEvent<
  "checkout.sell-list.line-added",
  Omit<CheckoutSellListLine, "selectedOptions"> & {
    selectedOptions: VersionSelectedOptionEntry[];
  }
>;

export type SellListLineRemovedEvent = DomainEvent<
  "checkout.sell-list.line-removed",
  Readonly<{ lineId: SellListLineId }>
>;

export type SellListLineQuantitySetEvent = DomainEvent<
  "checkout.sell-list.line-quantity-set",
  Readonly<{ lineId: SellListLineId; quantity: number }>
>;

export type SellListCheckedOutEvent = DomainEvent<
  "checkout.sell-list.checked-out",
  Readonly<{ sellerAccountId: AccountId; checkedOutAt: string }>
>;

export type CheckoutSellListEvent =
  | SellListLineAddedEvent
  | SellListLineQuantitySetEvent
  | SellListLineRemovedEvent
  | SellListCheckedOutEvent;

function requireSellListLine(state: CheckoutSellListState, lineId: SellListLineId) {
  const line = state.lines.find((entry) => entry.lineId === lineId);
  assert(line, "Sell list line not found.");
  return line;
}

function normalizeLineType(value: string) {
  return value === "selected-offer" ? "selected-offer" : "product";
}

function normalizeFallbackMode(value: string | undefined) {
  return value === "create-listing" ? "create-listing" : "none";
}

export const decideCheckoutSellList: AggregateDecider<
  CheckoutSellListState,
  CheckoutSellListCommand,
  CheckoutSellListEvent
> = (state, command) => {
  switch (command.type) {
    case "AddSellListLine": {
      assert(
        state.sellerAccountId === null || state.sellerAccountId === command.sellerAccountId,
        "Sell list is owned by a different account.",
      );
      assert(
        !state.lines.some((line) => line.lineId === command.lineId),
        "Sell list line has already been added.",
      );
      const lineType = normalizeLineType(command.lineType);
      const offerId = normalizeOptionalText(command.offerId);
      assert(
        lineType === "product" || Boolean(offerId),
        "Selected offer sell-list lines must reference an offer.",
      );

      return [
        {
          type: "checkout.sell-list.line-added",
          data: {
            sellerAccountId: command.sellerAccountId,
            lineId: command.lineId,
            lineType,
            offerId,
            buyerAccountId: normalizeOptionalText(command.buyerAccountId),
            buyerDisplayName: normalizeOptionalText(command.buyerDisplayName),
            offerPriceAmount: normalizeOptionalText(command.offerPriceAmount),
            catalogItemId: normalizeRequiredText(
              command.catalogItemId,
              "Sell list lines must reference a catalog item.",
            ),
            productId: normalizeRequiredText(
              command.productId,
              "Sell list lines must reference a product.",
            ),
            itemTitle: normalizeRequiredText(
              command.itemTitle,
              "Sell list lines must include an item title snapshot.",
            ),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            selectedOptions: normalizeVersionSelection(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            quantity: ensurePositiveInteger(
              command.quantity,
              "Sell list quantity must be a positive whole number.",
            ),
            fallbackMode: normalizeFallbackMode(command.fallbackMode),
            minimumListingPriceAmount: normalizeOptionalText(command.minimumListingPriceAmount),
          },
        },
      ];
    }
    case "SetSellListLineQuantity":
      requireSellListLine(state, command.lineId);
      return [
        {
          type: "checkout.sell-list.line-quantity-set",
          data: {
            lineId: command.lineId,
            quantity: ensurePositiveInteger(
              command.quantity,
              "Sell list quantity must be a positive whole number.",
            ),
          },
        },
      ];
    case "RemoveSellListLine":
      requireSellListLine(state, command.lineId);
      return [
        {
          type: "checkout.sell-list.line-removed",
          data: { lineId: command.lineId },
        },
      ];
    case "CheckoutSellList":
      assert(state.sellerAccountId !== null, "Sell list has not been initialized.");
      assert(state.lines.length > 0, "Sell list must contain at least one line.");
      return [
        {
          type: "checkout.sell-list.checked-out",
          data: {
            sellerAccountId: state.sellerAccountId,
            checkedOutAt: normalizeRequiredText(
              command.checkedOutAt,
              "Sell list checkout must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCheckoutSellList: AggregateEvolver<
  CheckoutSellListState,
  CheckoutSellListEvent
> = (state, event) => {
  switch (event.type) {
    case "checkout.sell-list.line-added":
      return {
        sellerAccountId: event.data.sellerAccountId,
        lines: [...state.lines, event.data],
        lastCheckedOutAt: state.lastCheckedOutAt,
      };
    case "checkout.sell-list.line-removed":
      return {
        ...state,
        lines: state.lines.filter((line) => line.lineId !== event.data.lineId),
      };
    case "checkout.sell-list.line-quantity-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? { ...line, quantity: event.data.quantity }
            : line,
        ),
      };
    case "checkout.sell-list.checked-out":
      return {
        sellerAccountId: event.data.sellerAccountId,
        lines: [],
        lastCheckedOutAt: event.data.checkedOutAt,
      };
    default:
      return assertNever(event);
  }
};

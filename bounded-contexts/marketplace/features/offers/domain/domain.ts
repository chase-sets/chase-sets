import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function ensurePositiveInteger(value: number, message: string): number {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeMoneyAmount(value: string): string {
  const normalized = value.trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Offer price amount must be a valid decimal.");
  assert(
    Number.parseFloat(normalized) > 0,
    "Offer price amount must be greater than zero.",
  );
  return normalized;
}

function normalizeVersionSelection(
  value: readonly { dimensionId: string; optionId: string }[],
) {
  const normalized = value
    .map((selection) => ({
      dimensionId: normalizeRequiredText(
        selection.dimensionId,
        "Offer selected options must include a dimension.",
      ),
      optionId: normalizeRequiredText(
        selection.optionId,
        "Offer selected options must include an option.",
      ),
    }))
    .sort((left, right) =>
      left.dimensionId.localeCompare(right.dimensionId) ||
      left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();

  for (const selection of normalized) {
    assert(
      !seen.has(selection.dimensionId),
      "Offer selected options cannot include duplicate dimensions.",
    );
    seen.add(selection.dimensionId);
  }

  return normalized;
}

export type OfferStatus = "draft" | "submitted" | "accepted";

export type MarketplaceOfferState = Readonly<{
  offerId: OfferId | null;
  buyerAccountId: AccountId | null;
  catalogItemId: string | null;
  productId: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  priceAmount: string | null;
  quantityRequested: number;
  status: OfferStatus;
  acceptedSellerAccountId: AccountId | null;
  acceptedAt: string | null;
}>;

export const initialMarketplaceOfferState: MarketplaceOfferState = {
  offerId: null,
  buyerAccountId: null,
  catalogItemId: null,
  productId: null,
  itemTitle: null,
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  priceAmount: null,
  quantityRequested: 0,
  status: "draft",
  acceptedSellerAccountId: null,
  acceptedAt: null,
};

export type SubmitOfferCommand = Readonly<{
  type: "SubmitOffer";
  offerId: OfferId;
  buyerAccountId: AccountId;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  priceAmount: string;
  quantityRequested: number;
}>;

export type AcceptOfferCommand = Readonly<{
  type: "AcceptOffer";
  sellerAccountId: AccountId;
  acceptedAt: string;
}>;

export type MarketplaceOfferCommand = SubmitOfferCommand | AcceptOfferCommand;

export type OfferSubmittedEvent = DomainEvent<
  "marketplace.offer.submitted",
  Readonly<{
    offerId: OfferId;
    buyerAccountId: AccountId;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    priceAmount: string;
    quantityRequested: number;
  }>
>;

export type OfferAcceptedEvent = DomainEvent<
  "marketplace.offer.accepted",
  Readonly<{
    offerId: OfferId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    priceAmount: string;
    quantityRequested: number;
    acceptedAt: string;
  }>
>;

export type MarketplaceOfferEvent = OfferSubmittedEvent | OfferAcceptedEvent;

export const decideMarketplaceOffer: AggregateDecider<
  MarketplaceOfferState,
  MarketplaceOfferCommand,
  MarketplaceOfferEvent
> = (state, command) => {
  switch (command.type) {
    case "SubmitOffer":
      assert(state.offerId === null, "Offer has already been submitted.");

      return [
        {
          type: "marketplace.offer.submitted",
          data: {
            offerId: command.offerId,
            buyerAccountId: command.buyerAccountId,
            catalogItemId: normalizeRequiredText(
              command.catalogItemId,
              "Offer must reference a catalog item.",
            ),
            productId: command.productId,
            itemTitle: normalizeRequiredText(
              command.itemTitle,
              "Offer must include an item title snapshot.",
            ),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            selectedOptions: normalizeVersionSelection(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            priceAmount: normalizeMoneyAmount(command.priceAmount),
            quantityRequested: ensurePositiveInteger(
              command.quantityRequested,
              "Offer quantity requested must be a positive whole number.",
            ),
          },
        },
      ];
    case "AcceptOffer":
      assert(state.offerId !== null, "Offer must be submitted first.");
      assert(state.status === "submitted", "Only submitted offers can be accepted.");

      return [
        {
          type: "marketplace.offer.accepted",
          data: {
            offerId: state.offerId,
            buyerAccountId: state.buyerAccountId!,
            sellerAccountId: command.sellerAccountId,
            catalogItemId: state.catalogItemId!,
            productId: state.productId!,
            itemTitle: state.itemTitle!,
            itemSubtitle: state.itemSubtitle,
            selectedOptions: [...state.selectedOptions],
            productSummary: state.productSummary,
            priceAmount: state.priceAmount!,
            quantityRequested: state.quantityRequested,
            acceptedAt: normalizeRequiredText(
              command.acceptedAt,
              "Offer acceptance must record a timestamp.",
            ),
          },
        },
      ];
    default:
      throw new Error(`Unhandled marketplace offer command: ${JSON.stringify(command)}`);
  }
};

export const evolveMarketplaceOffer: AggregateEvolver<
  MarketplaceOfferState,
  MarketplaceOfferEvent
> = (state, event) => {
  if (event.type === "marketplace.offer.submitted") {
    return {
      offerId: event.data.offerId,
      buyerAccountId: event.data.buyerAccountId,
      catalogItemId: event.data.catalogItemId,
      productId: event.data.productId,
      itemTitle: event.data.itemTitle,
      itemSubtitle: event.data.itemSubtitle,
      selectedOptions: event.data.selectedOptions,
      productSummary: event.data.productSummary,
      priceAmount: event.data.priceAmount,
      quantityRequested: event.data.quantityRequested,
      status: "submitted",
      acceptedSellerAccountId: null,
      acceptedAt: null,
    };
  }

  if (event.type === "marketplace.offer.accepted") {
    return {
      ...state,
      status: "accepted",
      acceptedSellerAccountId: event.data.sellerAccountId,
      acceptedAt: event.data.acceptedAt,
    };
  }

  throw new Error(`Unhandled marketplace offer event: ${JSON.stringify(event)}`);
};

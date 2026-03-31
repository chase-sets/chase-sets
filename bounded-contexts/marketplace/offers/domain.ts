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
  value: readonly { dimensionId: string; choiceId: string }[],
) {
  const normalized = value
    .map((selection) => ({
      dimensionId: normalizeRequiredText(
        selection.dimensionId,
        "Offer version selection must include a dimension.",
      ),
      choiceId: normalizeRequiredText(
        selection.choiceId,
        "Offer version selection must include a choice.",
      ),
    }))
    .sort((left, right) =>
      left.dimensionId.localeCompare(right.dimensionId) ||
      left.choiceId.localeCompare(right.choiceId),
    );

  const seen = new Set<string>();

  for (const selection of normalized) {
    assert(
      !seen.has(selection.dimensionId),
      "Offer version selection cannot include duplicate dimensions.",
    );
    seen.add(selection.dimensionId);
  }

  return normalized;
}

export type OfferStatus = "draft" | "submitted";

export type MarketplaceOfferState = Readonly<{
  offerId: OfferId | null;
  buyerAccountId: AccountId | null;
  catalogItemId: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  priceAmount: string | null;
  quantityRequested: number;
  status: OfferStatus;
}>;

export const initialMarketplaceOfferState: MarketplaceOfferState = {
  offerId: null,
  buyerAccountId: null,
  catalogItemId: null,
  itemTitle: null,
  itemSubtitle: null,
  versionSelection: [],
  versionSummary: null,
  priceAmount: null,
  quantityRequested: 0,
  status: "draft",
};

export type SubmitOfferCommand = Readonly<{
  type: "SubmitOffer";
  offerId: OfferId;
  buyerAccountId: AccountId;
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  priceAmount: string;
  quantityRequested: number;
}>;

export type MarketplaceOfferCommand = SubmitOfferCommand;

export type OfferSubmittedEvent = DomainEvent<
  "marketplace.offer.submitted",
  Readonly<{
    offerId: OfferId;
    buyerAccountId: AccountId;
    catalogItemId: string;
    itemTitle: string;
    itemSubtitle: string | null;
    versionSelection: { dimensionId: string; choiceId: string }[];
    versionSummary: string | null;
    priceAmount: string;
    quantityRequested: number;
  }>
>;

export type MarketplaceOfferEvent = OfferSubmittedEvent;

export const decideMarketplaceOffer: AggregateDecider<
  MarketplaceOfferState,
  MarketplaceOfferCommand,
  MarketplaceOfferEvent
> = (state, command) => {
  if (command.type === "SubmitOffer") {
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
          itemTitle: normalizeRequiredText(
            command.itemTitle,
            "Offer must include an item title snapshot.",
          ),
          itemSubtitle: normalizeOptionalText(command.itemSubtitle),
          versionSelection: normalizeVersionSelection(command.versionSelection),
          versionSummary: normalizeOptionalText(command.versionSummary),
          priceAmount: normalizeMoneyAmount(command.priceAmount),
          quantityRequested: ensurePositiveInteger(
            command.quantityRequested,
            "Offer quantity requested must be a positive whole number.",
          ),
        },
      },
    ];
  }

  throw new Error(`Unhandled marketplace offer command: ${JSON.stringify(command)}`);
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
      itemTitle: event.data.itemTitle,
      itemSubtitle: event.data.itemSubtitle,
      versionSelection: event.data.versionSelection,
      versionSummary: event.data.versionSummary,
      priceAmount: event.data.priceAmount,
      quantityRequested: event.data.quantityRequested,
      status: "submitted",
    };
  }

  throw new Error(`Unhandled marketplace offer event: ${JSON.stringify(event)}`);
};

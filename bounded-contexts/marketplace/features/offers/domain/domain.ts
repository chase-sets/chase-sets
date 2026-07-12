import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OfferId } from "@chase-sets/primitives/typed-ids";

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
  assert(Number.parseFloat(normalized) > 0, "Offer price amount must be greater than zero.");
  return normalized;
}

function normalizeNonNegativeMoneyAmount(value: string, fieldName: string): string {
  const normalized = value.trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid decimal.`);
  return normalized;
}

function normalizePercentageBps(value: number, fieldName: string): number {
  assert(Number.isInteger(value), `${fieldName} must be a whole number of basis points.`);
  assert(value >= 0, `${fieldName} must be zero or greater.`);
  return value;
}

function normalizeVersionSelection(value: readonly { dimensionId: string; optionId: string }[]) {
  const normalized = value
    .map((selection) => ({
      dimensionId: normalizeRequiredText(selection.dimensionId, "Offer selected options must include a dimension."),
      optionId: normalizeRequiredText(selection.optionId, "Offer selected options must include an option."),
    }))
    .sort(
      (left, right) => left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();

  for (const selection of normalized) {
    assert(!seen.has(selection.dimensionId), "Offer selected options cannot include duplicate dimensions.");
    seen.add(selection.dimensionId);
  }

  return normalized;
}

export type OfferStatus = "draft" | "submitted" | "accepted";

export type MarketplaceOfferState = Readonly<{
  offerId: OfferId | null;
  buyerAccountId: AccountId | null;
  catalogItemId: CatalogItemId | null;
  productId: ProductKey | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  shippingDestinationSnapshot: AddressSnapshot | null;
  priceAmount: string | null;
  quantityRequested: number;
  status: OfferStatus;
  acceptedSellerAccountId: AccountId | null;
  acceptedAt: string | null;
  marketplaceSalesFeePercentageBps: number | null;
  marketplaceSalesFeeFixedAmount: string | null;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps: number | null;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeQuoteFingerprint: string | null;
  acceptanceBatchId: string | null;
  acceptanceBatchSize: number | null;
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
  shippingDestinationSnapshot: null,
  priceAmount: null,
  quantityRequested: 0,
  status: "draft",
  acceptedSellerAccountId: null,
  acceptedAt: null,
  marketplaceSalesFeePercentageBps: null,
  marketplaceSalesFeeFixedAmount: null,
  marketplaceSalesFeeCapAmount: null,
  marketplaceSalesFeeUnitAmount: null,
  sellerNetUnitAmount: null,
  shippingAllowancePercentageBps: null,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeQuoteFingerprint: null,
  acceptanceBatchId: null,
  acceptanceBatchSize: null,
};

export type SubmitOfferCommand = Readonly<{
  type: "SubmitOffer";
  offerId: OfferId;
  buyerAccountId: AccountId;
  sellerAccountId?: AccountId | null;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  shippingDestinationSnapshot: AddressSnapshot;
  priceAmount: string;
  quantityRequested: number;
}>;

export type AcceptOfferCommand = Readonly<{
  type: "AcceptOffer";
  sellerAccountId: AccountId;
  acceptedAt: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeQuoteFingerprint: string;
  acceptanceBatchId?: string | null;
  acceptanceBatchSize?: number | null;
}>;

export type MarketplaceOfferCommand = SubmitOfferCommand | AcceptOfferCommand;

export type OfferSubmittedEvent = DomainEvent<
  "marketplace.offer.submitted",
  Readonly<{
    offerId: OfferId;
    buyerAccountId: AccountId;
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    shippingDestinationSnapshot: AddressSnapshot;
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
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    shippingDestinationSnapshot: AddressSnapshot;
    priceAmount: string;
    quantityRequested: number;
    acceptedAt: string;
    marketplaceSalesFeePercentageBps?: number;
    marketplaceSalesFeeFixedAmount?: string;
    marketplaceSalesFeeCapAmount?: string | null;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    feeQuoteFingerprint: string;
    acceptanceBatchId: string | null;
    acceptanceBatchSize: number | null;
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
      if (command.sellerAccountId) {
        assert(command.buyerAccountId !== command.sellerAccountId, "Accounts cannot offer on their own listings.");
      }

      return [
        {
          type: "marketplace.offer.submitted",
          data: {
            offerId: command.offerId,
            buyerAccountId: command.buyerAccountId,
            catalogItemId: normalizeRequiredText(
              command.catalogItemId,
              "Offer must reference a catalog item.",
            ) as CatalogItemId,
            productId: command.productId,
            itemTitle: normalizeRequiredText(command.itemTitle, "Offer must include an item title snapshot."),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            selectedOptions: normalizeVersionSelection(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            shippingDestinationSnapshot: normalizeAddressSnapshot(
              command.shippingDestinationSnapshot,
              "Shipping destination",
            ),
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
      assert(state.buyerAccountId !== command.sellerAccountId, "Accounts cannot accept their own offers.");

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
            shippingDestinationSnapshot: state.shippingDestinationSnapshot!,
            priceAmount: state.priceAmount!,
            quantityRequested: state.quantityRequested,
            acceptedAt: normalizeRequiredText(command.acceptedAt, "Offer acceptance must record a timestamp."),
            marketplaceSalesFeePercentageBps: normalizePercentageBps(
              command.marketplaceSalesFeePercentageBps,
              "Marketplace sales fee percentage",
            ),
            marketplaceSalesFeeFixedAmount: normalizeNonNegativeMoneyAmount(
              command.marketplaceSalesFeeFixedAmount,
              "Marketplace sales fee fixed amount",
            ),
            marketplaceSalesFeeCapAmount:
              command.marketplaceSalesFeeCapAmount === null
                ? null
                : normalizeNonNegativeMoneyAmount(
                    command.marketplaceSalesFeeCapAmount,
                    "Marketplace sales fee cap amount",
                  ),
            marketplaceSalesFeeUnitAmount: normalizeNonNegativeMoneyAmount(
              command.marketplaceSalesFeeUnitAmount,
              "Marketplace sales fee unit amount",
            ),
            sellerNetUnitAmount: normalizeNonNegativeMoneyAmount(command.sellerNetUnitAmount, "Seller net unit amount"),
            shippingAllowancePercentageBps: normalizePercentageBps(
              command.shippingAllowancePercentageBps ?? 500,
              "Shipping allowance percentage",
            ),
            termsScheduleId: normalizeOptionalText(command.termsScheduleId),
            termsAgreementId: normalizeOptionalText(command.termsAgreementId),
            termsResolvedAt: normalizeRequiredText(
              command.termsResolvedAt,
              "Offer acceptance terms must record a timestamp.",
            ),
            feeQuoteFingerprint: normalizeRequiredText(
              command.feeQuoteFingerprint,
              "Offer acceptance must record a fee quote fingerprint.",
            ),
            acceptanceBatchId: normalizeOptionalText(command.acceptanceBatchId),
            acceptanceBatchSize:
              command.acceptanceBatchId == null
                ? null
                : ensurePositiveInteger(
                    command.acceptanceBatchSize ?? 1,
                    "Offer acceptance batch size must be a positive whole number.",
                  ),
          },
        },
      ];
    default:
      throw new Error(`Unhandled marketplace offer command: ${JSON.stringify(command)}`);
  }
};

export const evolveMarketplaceOffer: AggregateEvolver<MarketplaceOfferState, MarketplaceOfferEvent> = (
  state,
  event,
) => {
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
      shippingDestinationSnapshot: event.data.shippingDestinationSnapshot,
      priceAmount: event.data.priceAmount,
      quantityRequested: event.data.quantityRequested,
      status: "submitted",
      acceptedSellerAccountId: null,
      acceptedAt: null,
      marketplaceSalesFeePercentageBps: null,
      marketplaceSalesFeeFixedAmount: null,
      marketplaceSalesFeeCapAmount: null,
      marketplaceSalesFeeUnitAmount: null,
      sellerNetUnitAmount: null,
      shippingAllowancePercentageBps: null,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: null,
      feeQuoteFingerprint: null,
      acceptanceBatchId: null,
      acceptanceBatchSize: null,
    };
  }

  if (event.type === "marketplace.offer.accepted") {
    return {
      ...state,
      status: "accepted",
      acceptedSellerAccountId: event.data.sellerAccountId,
      acceptedAt: event.data.acceptedAt,
      marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps ?? null,
      marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount ?? null,
      marketplaceSalesFeeCapAmount: event.data.marketplaceSalesFeeCapAmount ?? null,
      marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
      sellerNetUnitAmount: event.data.sellerNetUnitAmount,
      shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
      termsScheduleId: event.data.termsScheduleId,
      termsAgreementId: event.data.termsAgreementId,
      termsResolvedAt: event.data.termsResolvedAt,
      feeQuoteFingerprint: event.data.feeQuoteFingerprint,
      acceptanceBatchId: event.data.acceptanceBatchId,
      acceptanceBatchSize: event.data.acceptanceBatchSize,
    };
  }

  throw new Error(`Unhandled marketplace offer event: ${JSON.stringify(event)}`);
};

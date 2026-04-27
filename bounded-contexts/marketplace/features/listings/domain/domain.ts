import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function ensurePositiveInteger(value: number, message: string): number {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ fieldName?: string; allowZero?: boolean }> = {},
): string {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Price amount";
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid decimal.`);
  assert(
    options.allowZero
      ? Number.parseFloat(normalized) >= 0
      : Number.parseFloat(normalized) > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );
  return normalized;
}

export type ListingStatus = "draft" | "active" | "paused" | "withdrawn";

export type MarketplaceListingState = Readonly<{
  listingId: ListingId | null;
  accountId: AccountId | null;
  inventoryRecordId: string | null;
  catalogItemId: string | null;
  productId: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string | null;
  marketplaceFeeAmount: string | null;
  paymentFeeAmount: string | null;
  sellerNetAmount: string | null;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  quantityCap: number;
  status: ListingStatus;
}>;

export const initialMarketplaceListingState: MarketplaceListingState = {
  listingId: null,
  accountId: null,
  inventoryRecordId: null,
  catalogItemId: null,
  productId: null,
  itemTitle: null,
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: null,
  shipFromCode: null,
  priceAmount: null,
  marketplaceFeeAmount: null,
  paymentFeeAmount: null,
  sellerNetAmount: null,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  quantityCap: 0,
  status: "draft",
};

export type CreateListingCommand = Readonly<{
  type: "CreateListing";
  listingId: ListingId;
  accountId: AccountId;
  inventoryRecordId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  marketplaceFeeAmount?: string | null;
  paymentFeeAmount?: string | null;
  sellerNetAmount?: string | null;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  quantityCap: number;
}>;

export type UpdateListingPriceCommand = Readonly<{
  type: "UpdateListingPrice";
  priceAmount: string;
  marketplaceFeeAmount?: string | null;
  paymentFeeAmount?: string | null;
  sellerNetAmount?: string | null;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
}>;

export type UpdateListingQuantityCapCommand = Readonly<{
  type: "UpdateListingQuantityCap";
  quantityCap: number;
}>;

export type PublishListingCommand = Readonly<{ type: "PublishListing" }>;
export type PauseListingCommand = Readonly<{ type: "PauseListing" }>;
export type WithdrawListingCommand = Readonly<{ type: "WithdrawListing" }>;

export type MarketplaceListingCommand =
  | CreateListingCommand
  | UpdateListingPriceCommand
  | UpdateListingQuantityCapCommand
  | PublishListingCommand
  | PauseListingCommand
  | WithdrawListingCommand;

export type ListingCreatedEvent = DomainEvent<
  "marketplace.listing.created",
  Readonly<{
    listingId: ListingId;
    accountId: AccountId;
    inventoryRecordId: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string | null;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    storageLocationName: string | null;
    shipFromCode: string | null;
    priceAmount: string;
    marketplaceFeeAmount: string | null;
    paymentFeeAmount: string | null;
    sellerNetAmount: string | null;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    quantityCap: number;
  }>
>;
export type ListingPriceUpdatedEvent = DomainEvent<
  "marketplace.listing.price-updated",
  Readonly<{
    priceAmount: string;
    marketplaceFeeAmount: string | null;
    paymentFeeAmount: string | null;
    sellerNetAmount: string | null;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
  }>
>;
export type ListingQuantityCapUpdatedEvent = DomainEvent<
  "marketplace.listing.quantity-cap-updated",
  Readonly<{ quantityCap: number }>
>;
export type ListingPublishedEvent = DomainEvent<
  "marketplace.listing.published",
  Readonly<Record<string, never>>
>;
export type ListingPausedEvent = DomainEvent<
  "marketplace.listing.paused",
  Readonly<Record<string, never>>
>;
export type ListingWithdrawnEvent = DomainEvent<
  "marketplace.listing.withdrawn",
  Readonly<Record<string, never>>
>;

export type MarketplaceListingEvent =
  | ListingCreatedEvent
  | ListingPriceUpdatedEvent
  | ListingQuantityCapUpdatedEvent
  | ListingPublishedEvent
  | ListingPausedEvent
  | ListingWithdrawnEvent;

export const decideMarketplaceListing: AggregateDecider<
  MarketplaceListingState,
  MarketplaceListingCommand,
  MarketplaceListingEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateListing":
      assert(state.listingId === null, "Listing has already been created.");
      return [
        {
          type: "marketplace.listing.created",
          data: {
            listingId: command.listingId,
            accountId: command.accountId,
            inventoryRecordId: command.inventoryRecordId.trim(),
            catalogItemId: command.catalogItemId.trim(),
            productId: command.productId,
            itemTitle: command.itemTitle?.trim() ?? null,
            itemSubtitle: command.itemSubtitle?.trim() ?? null,
            selectedOptions: command.selectedOptions.map((selection) => ({
              dimensionId: selection.dimensionId.trim(),
              optionId: selection.optionId.trim(),
            })),
            productSummary: command.productSummary?.trim() ?? null,
            storageLocationName: command.storageLocationName?.trim() ?? null,
            shipFromCode: command.shipFromCode?.trim() ?? null,
            priceAmount: normalizeMoneyAmount(command.priceAmount),
            marketplaceFeeAmount:
              command.marketplaceFeeAmount === undefined || command.marketplaceFeeAmount === null
                ? null
                : normalizeMoneyAmount(command.marketplaceFeeAmount, {
                    fieldName: "Marketplace fee amount",
                    allowZero: true,
                  }),
            paymentFeeAmount:
              command.paymentFeeAmount === undefined || command.paymentFeeAmount === null
                ? null
                : normalizeMoneyAmount(command.paymentFeeAmount, {
                    fieldName: "Payment fee amount",
                    allowZero: true,
                  }),
            sellerNetAmount:
              command.sellerNetAmount === undefined || command.sellerNetAmount === null
                ? null
                : normalizeMoneyAmount(command.sellerNetAmount, {
                    fieldName: "Seller net amount",
                    allowZero: true,
                  }),
            termsScheduleId: command.termsScheduleId?.trim() ?? null,
            termsAgreementId: command.termsAgreementId?.trim() ?? null,
            termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
            quantityCap: ensurePositiveInteger(
              command.quantityCap,
              "Listing quantity cap must be a positive whole number.",
            ),
          },
        },
      ];
    case "UpdateListingPrice":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      return [
        {
          type: "marketplace.listing.price-updated",
          data: {
            priceAmount: normalizeMoneyAmount(command.priceAmount),
            marketplaceFeeAmount:
              command.marketplaceFeeAmount === undefined || command.marketplaceFeeAmount === null
                ? null
                : normalizeMoneyAmount(command.marketplaceFeeAmount, {
                    fieldName: "Marketplace fee amount",
                    allowZero: true,
                  }),
            paymentFeeAmount:
              command.paymentFeeAmount === undefined || command.paymentFeeAmount === null
                ? null
                : normalizeMoneyAmount(command.paymentFeeAmount, {
                    fieldName: "Payment fee amount",
                    allowZero: true,
                  }),
            sellerNetAmount:
              command.sellerNetAmount === undefined || command.sellerNetAmount === null
                ? null
                : normalizeMoneyAmount(command.sellerNetAmount, {
                    fieldName: "Seller net amount",
                    allowZero: true,
                  }),
            termsScheduleId: command.termsScheduleId?.trim() ?? null,
            termsAgreementId: command.termsAgreementId?.trim() ?? null,
            termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
          },
        },
      ];
    case "UpdateListingQuantityCap":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      return [
        {
          type: "marketplace.listing.quantity-cap-updated",
          data: {
            quantityCap: ensurePositiveInteger(
              command.quantityCap,
              "Listing quantity cap must be a positive whole number.",
            ),
          },
        },
      ];
    case "PublishListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be published.");
      assert(state.status !== "active", "Listing is already active.");
      return [{ type: "marketplace.listing.published", data: {} }];
    case "PauseListing":
      assert(state.listingId !== null, "Listing must be created first.");
      if (state.status === "paused") {
        return [];
      }
      assert(state.status === "active", "Only active listings can be paused.");
      return [{ type: "marketplace.listing.paused", data: {} }];
    case "WithdrawListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Listing has already been withdrawn.");
      return [{ type: "marketplace.listing.withdrawn", data: {} }];
    default:
      return assertNever(command);
  }
};

export const evolveMarketplaceListing: AggregateEvolver<
  MarketplaceListingState,
  MarketplaceListingEvent
> = (state, event) => {
  switch (event.type) {
    case "marketplace.listing.created":
      return {
        listingId: event.data.listingId,
        accountId: event.data.accountId,
        inventoryRecordId: event.data.inventoryRecordId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        itemTitle: event.data.itemTitle,
        itemSubtitle: event.data.itemSubtitle,
        selectedOptions: event.data.selectedOptions,
        productSummary: event.data.productSummary,
        storageLocationName: event.data.storageLocationName,
        shipFromCode: event.data.shipFromCode,
        priceAmount: event.data.priceAmount,
        marketplaceFeeAmount: event.data.marketplaceFeeAmount,
        paymentFeeAmount: event.data.paymentFeeAmount,
        sellerNetAmount: event.data.sellerNetAmount,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        quantityCap: event.data.quantityCap,
        status: "draft",
      };
    case "marketplace.listing.price-updated":
      return {
        ...state,
        priceAmount: event.data.priceAmount,
        marketplaceFeeAmount: event.data.marketplaceFeeAmount,
        paymentFeeAmount: event.data.paymentFeeAmount,
        sellerNetAmount: event.data.sellerNetAmount,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
      };
    case "marketplace.listing.quantity-cap-updated":
      return { ...state, quantityCap: event.data.quantityCap };
    case "marketplace.listing.published":
      return { ...state, status: "active" };
    case "marketplace.listing.paused":
      return { ...state, status: "paused" };
    case "marketplace.listing.withdrawn":
      return { ...state, status: "withdrawn" };
    default:
      return assertNever(event);
  }
};

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

function normalizeMoneyAmount(value: string): string {
  const normalized = value.trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Price amount must be a valid decimal.");
  assert(Number.parseFloat(normalized) > 0, "Price amount must be greater than zero.");
  return normalized;
}

export type ListingStatus = "draft" | "active" | "paused" | "withdrawn";

export type MarketplaceListingState = Readonly<{
  listingId: ListingId | null;
  accountId: AccountId | null;
  inventoryRecordId: string | null;
  catalogItemId: string | null;
  catalogVersionKey: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string | null;
  quantityCap: number;
  status: ListingStatus;
}>;

export const initialMarketplaceListingState: MarketplaceListingState = {
  listingId: null,
  accountId: null,
  inventoryRecordId: null,
  catalogItemId: null,
  catalogVersionKey: null,
  itemTitle: null,
  itemSubtitle: null,
  versionSelection: [],
  versionSummary: null,
  storageLocationName: null,
  shipFromCode: null,
  priceAmount: null,
  quantityCap: 0,
  status: "draft",
};

export type CreateListingCommand = Readonly<{
  type: "CreateListing";
  listingId: ListingId;
  accountId: AccountId;
  inventoryRecordId: string;
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string | null;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  quantityCap: number;
}>;

export type UpdateListingPriceCommand = Readonly<{
  type: "UpdateListingPrice";
  priceAmount: string;
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
    catalogVersionKey: string;
    itemTitle: string | null;
    itemSubtitle: string | null;
    versionSelection: { dimensionId: string; choiceId: string }[];
    versionSummary: string | null;
    storageLocationName: string | null;
    shipFromCode: string | null;
    priceAmount: string;
    quantityCap: number;
  }>
>;
export type ListingPriceUpdatedEvent = DomainEvent<
  "marketplace.listing.price-updated",
  Readonly<{ priceAmount: string }>
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
            catalogVersionKey: command.catalogVersionKey,
            itemTitle: command.itemTitle?.trim() ?? null,
            itemSubtitle: command.itemSubtitle?.trim() ?? null,
            versionSelection: command.versionSelection.map((selection) => ({
              dimensionId: selection.dimensionId.trim(),
              choiceId: selection.choiceId.trim(),
            })),
            versionSummary: command.versionSummary?.trim() ?? null,
            storageLocationName: command.storageLocationName?.trim() ?? null,
            shipFromCode: command.shipFromCode?.trim() ?? null,
            priceAmount: normalizeMoneyAmount(command.priceAmount),
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
          data: { priceAmount: normalizeMoneyAmount(command.priceAmount) },
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
        catalogVersionKey: event.data.catalogVersionKey,
        itemTitle: event.data.itemTitle,
        itemSubtitle: event.data.itemSubtitle,
        versionSelection: event.data.versionSelection,
        versionSummary: event.data.versionSummary,
        storageLocationName: event.data.storageLocationName,
        shipFromCode: event.data.shipFromCode,
        priceAmount: event.data.priceAmount,
        quantityCap: event.data.quantityCap,
        status: "draft",
      };
    case "marketplace.listing.price-updated":
      return { ...state, priceAmount: event.data.priceAmount };
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


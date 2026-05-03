import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import { quoteMarketplaceTerms } from "../../../support/runtime-support/fee-quotes";
import type { MarketplaceListingTermsPreview } from "../ui/contracts";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import {
  getActiveQuantityCapForInventoryItem,
  getInventoryItemSupply,
  getMarketSummaryForItem,
  getSellerListing,
  listActiveListingsForInventoryItem,
  listItemListings,
  listSellerInventoryItemSupply,
  listSellerListings,
} from "../read-model/queries";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as never;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as never;

function createMarketplaceSystemContext(accountId: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_SYSTEM_USER_ID,
      forAccountId: accountId as never,
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export class MarketplaceFeeQuoteStaleError extends Error {
  public constructor(public readonly currentQuote: MarketplaceListingTermsPreview) {
    super("Fee quote is stale. Refresh the fee preview before continuing.");
    this.name = "MarketplaceFeeQuoteStaleError";
  }
}

export type MarketplaceListingServices = Readonly<{
  commandHandler: CommandHandler<
    MarketplaceListingCommand,
    MarketplaceListingState,
    MarketplaceListingEvent
  >;
  createListing: (
    params: Readonly<{
      accountId: AccountId;
      inventoryItemId: string;
      priceAmount: string;
      quantityCap: number;
      listingIdOverride?: ListingId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;
  previewListingTerms: (
    params: Readonly<{ accountId: string; priceAmount: string }>,
  ) => Promise<MarketplaceListingTermsPreview>;
  updateListingPrice: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      priceAmount: string;
      feeQuoteFingerprint?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  updateListingQuantityCap: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      quantityCap: number;
      feeQuoteFingerprint?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  publishListing: (
    params: Readonly<{ accountId: string; listingId: string; feeQuoteFingerprint?: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  pauseListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  withdrawListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  listSellerListings: (
    params: Parameters<typeof listSellerListings>[1],
  ) => ReturnType<typeof listSellerListings>;
  listSellerInventoryItemSupply: (
    params: Parameters<typeof listSellerInventoryItemSupply>[1],
  ) => ReturnType<typeof listSellerInventoryItemSupply>;
  getSellerListing: (
    listingId: string,
    accountId: string,
  ) => ReturnType<typeof getSellerListing>;
  getMarketSummaryForItem: (
    itemId: string,
  ) => ReturnType<typeof getMarketSummaryForItem>;
  listItemListings: (itemId: string) => ReturnType<typeof listItemListings>;
  getInventoryItemSupply: (
    itemId: string,
    accountId?: string,
  ) => ReturnType<typeof getInventoryItemSupply>;
  reconcileInventoryCapacity: (inventoryItemId: string) => Promise<void>;
  projectors: readonly Projector[];
}>;

type ListingRuntimeDeps = MarketplaceRuntimeDeps & Readonly<{
  commercialTermsResolver: CommercialTermsResolver;
}>;

export function createMarketplaceListingRuntime(
  deps: ListingRuntimeDeps,
): MarketplaceListingServices {
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });

  async function ensureActiveCapacity(
    inventoryItemId: string,
    requestedQuantityCap: number,
    excludeListingId?: string,
  ) {
    const supply = await getInventoryItemSupply(deps.db, inventoryItemId);
    assert(supply, "Inventory item not found.");

    const activeQuantityCap = await getActiveQuantityCapForInventoryItem(
      deps.db,
      inventoryItemId,
      excludeListingId,
    );
    assert(
      activeQuantityCap + requestedQuantityCap <= supply.available_quantity,
      "Active listing quantity caps cannot exceed current sellable inventory.",
    );
  }

  async function reconcileInventoryCapacity(inventoryItemId: string) {
    const supply = await getInventoryItemSupply(deps.db, inventoryItemId);
    if (!supply) {
      return;
    }

    const activeListings = await listActiveListingsForInventoryItem(
      deps.db,
      inventoryItemId,
    );
    let activeTotal = activeListings.reduce(
      (sum, listing) => sum + listing.quantity_cap,
      0,
    );

    for (const listing of activeListings) {
      if (activeTotal <= supply.available_quantity) {
        break;
      }

      await commandHandler({
        streamId: `marketplace.listing-${listing.listing_id}`,
        command: { type: "PauseListing" },
        context: createMarketplaceSystemContext(listing.account_id),
      });
      activeTotal -= listing.quantity_cap;
    }
  }

  async function loadOwnedListingState(listingId: string, accountId: string) {
    const aggregate = await repository.load(`marketplace.listing-${listingId}`);
    const listing = aggregate.state;

    assert(
      listing.listingId !== null && listing.accountId === accountId,
      "Listing not found.",
    );

    return listing;
  }

  async function quoteListingTerms(accountId: string, priceAmount: string) {
    return quoteMarketplaceTerms(deps.commercialTermsResolver, {
      accountId,
      priceAmount,
    });
  }

  function assertConfirmedFeeQuote(
    providedFingerprint: string | null | undefined,
    currentQuote: MarketplaceListingTermsPreview,
  ) {
    if (providedFingerprint !== currentQuote.fee_quote_fingerprint) {
      throw new MarketplaceFeeQuoteStaleError(currentQuote);
    }
  }

  return {
    commandHandler,
    createListing: async (params, context) => {
      const supply = await getInventoryItemSupply(
        deps.db,
        params.inventoryItemId,
        params.accountId,
      );
      assert(supply, "Inventory item not found.");
      const quote = await quoteListingTerms(params.accountId, params.priceAmount);

      const listingId = params.listingIdOverride ?? (createId("lst") as ListingId);
      const result = await commandHandler({
        streamId: `marketplace.listing-${listingId}`,
        command: {
          type: "CreateListing",
          listingId,
          accountId: params.accountId,
          inventoryItemId: supply.item_id,
          catalogItemId: supply.catalog_catalog_item_id,
          productId: supply.product_id as never,
          itemTitle: supply.item_title,
          itemSubtitle: supply.item_subtitle,
          selectedOptions: supply.selected_options,
          productSummary: supply.product_summary,
          gradedCard: supply.graded_card,
          storageLocationName: supply.storage_location_name,
          shipFromCode: supply.ship_from_code,
          priceAmount: params.priceAmount,
          marketplaceFeeUnitAmount: quote.marketplace_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
          quantityCap: params.quantityCap,
        },
        context,
      });

      return { listingId, version: result.version, feeQuoteFingerprint: quote.fee_quote_fingerprint };
    },
    previewListingTerms: async (params) => {
      return quoteListingTerms(params.accountId, params.priceAmount);
    },
    updateListingPrice: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const quote = await quoteListingTerms(params.accountId, params.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPrice",
          priceAmount: params.priceAmount,
          marketplaceFeeUnitAmount: quote.marketplace_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    updateListingQuantityCap: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.priceAmount, "Listing price is missing.");
      const quote = await quoteListingTerms(params.accountId, listing.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      if (listing.status === "active") {
        assert(listing.inventoryItemId, "Listing inventory item is missing.");
        await ensureActiveCapacity(
          listing.inventoryItemId,
          params.quantityCap,
          params.listingId,
        );
      }

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingQuantityCap",
          quantityCap: params.quantityCap,
          marketplaceFeeUnitAmount: quote.marketplace_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    publishListing: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.inventoryItemId, "Listing inventory item is missing.");
      assert(listing.priceAmount, "Listing price is missing.");
      const quote = await quoteListingTerms(params.accountId, listing.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      await ensureActiveCapacity(
        listing.inventoryItemId,
        listing.quantityCap,
        params.listingId,
      );

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "PublishListing",
          marketplaceFeeUnitAmount: quote.marketplace_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    pauseListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PauseListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    withdrawListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "WithdrawListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    listSellerListings: (params) => listSellerListings(deps.db, params),
    listSellerInventoryItemSupply: (params) =>
      listSellerInventoryItemSupply(deps.db, params),
    getSellerListing: (listingId, accountId) =>
      getSellerListing(deps.db, listingId, accountId),
    getMarketSummaryForItem: (itemId) => getMarketSummaryForItem(deps.db, itemId),
    listItemListings: (itemId) => listItemListings(deps.db, itemId),
    getInventoryItemSupply: (itemId, accountId) =>
      getInventoryItemSupply(deps.db, itemId, accountId),
    reconcileInventoryCapacity,
    projectors: [
      createProjector({
        projectorName: "marketplace-listing-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildMarketplaceListingProjectionHandlers(deps.db),
      }),
    ],
  };
}

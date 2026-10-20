import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { OwnerStreamReservation } from "@chase-sets/event-core/owner-seal";
import type {
  AcceptedListingTargetPriceV1,
  MarketplaceListingPriceDecision,
  MarketplaceListingPriceTarget,
} from "../domain/target-price";

export type { AcceptedListingTargetPriceV1, MarketplaceListingPriceDecision, MarketplaceListingPriceTarget };

export type ListingMutationInput = Readonly<{
  accountId: string;
  listingId: string;
  expectedListingVersion: number;
  idempotencyKey: string;
}>;
export type AcceptListingTargetPriceInput = ListingMutationInput &
  Readonly<{
    target: MarketplaceListingPriceTarget;
    priceAmount: string;
    priceCurrencyCode: string;
    expectedTargetPriceRevision: number;
    decision: MarketplaceListingPriceDecision;
  }>;
export type ActivateListingForChannelInput = ListingMutationInput &
  Readonly<{
    connectionId: string;
    expectedTargetPriceRevision: number;
    allocationRevision: number;
  }>;
export type ListingMutationResult = Readonly<{ listingId: string; version: number }>;
export type ListingTargetPriceAcceptanceResult = ListingMutationResult &
  Readonly<{ acceptedTargetPrice: AcceptedListingTargetPriceV1 }>;

export type ListingAuthorityResult<T> = Readonly<{ value: T; reservations: readonly OwnerStreamReservation[] }>;
export type ListingTargetAuthority = Readonly<{
  authorizeManage(
    input: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ): Promise<ListingAuthorityResult<boolean>>;
  resolveConnection(
    input: Readonly<{ accountId: string; connectionId: string }>,
  ): Promise<
    ListingAuthorityResult<
      (NonNullable<AcceptedListingTargetPriceV1["connectionAuthority"]> & Readonly<{ accountId: string }>) | null
    >
  >;
  resolveAllocation(
    input: Readonly<{
      accountId: string;
      inventoryItemId: string;
      productId: string;
      connectionId: string;
      allocationRevision: number;
    }>,
  ): Promise<
    ListingAuthorityResult<Readonly<{
      accountId: string;
      inventoryItemId: string;
      productId: string;
      allocationRevision: number;
      eligibleQuantity: number;
    }> | null>
  >;
  verifyDecision?(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
  ): Promise<ListingAuthorityResult<boolean>>;
}>;

export type AcceptedListingTargetPriceRead = Readonly<{
  listingId: string;
  target: MarketplaceListingPriceTarget;
  acceptedTargetPrice: AcceptedListingTargetPriceV1 | null;
  activationRevision: number | null;
  listingRevision: number;
}>;

export type ListingTargetServices = Readonly<{
  acceptListingTargetPrice(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
  ): Promise<ListingTargetPriceAcceptanceResult>;
  activateListingForChannel(
    input: ActivateListingForChannelInput,
    context: EventStoreContext,
  ): Promise<ListingMutationResult>;
  readAcceptedListingTargetPrices(
    input: Readonly<{
      accountId: string;
      targets: readonly Readonly<{ listingId: string; target: MarketplaceListingPriceTarget }>[];
    }>,
  ): Promise<readonly AcceptedListingTargetPriceRead[]>;
}>;

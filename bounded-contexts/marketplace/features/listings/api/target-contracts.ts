import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AcceptedListingTargetPriceV1,
  MarketplaceListingPriceDecision,
  MarketplaceListingPriceTarget,
  NativeListingEligibilityV1,
} from "@chase-sets/event-core/public-event-payloads";

export type {
  AcceptedListingTargetPriceV1,
  MarketplaceListingPriceDecision,
  MarketplaceListingPriceTarget,
  NativeListingEligibilityV1,
};

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

export type SetNativeListingVisibilityInput = ListingMutationInput &
  Readonly<{
    nativeVisibility: "enabled" | "disabled";
    feeQuoteFingerprint?: string;
  }>;

export type ResumeListingInput = ListingMutationInput &
  Readonly<{
    expectedPauseReason: "seller" | "policy-input-missing" | "channel-inbound-dark";
  }>;

export type ListingMutationResult = Readonly<{ listingId: string; version: number }>;
export type ListingTargetPriceAcceptanceResult = ListingMutationResult &
  Readonly<{ acceptedTargetPrice: AcceptedListingTargetPriceV1 }>;

/** Supplied by trusted owner adapters, never by a command's HTTP body. */
export type ListingAuthorityGuard = Readonly<{ streamId: string; expectedVersion: number }>;
export type ListingAuthorityResult<T> = Readonly<{ value: T; guards: readonly ListingAuthorityGuard[] }>;

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
  verifyDecision(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
  ): Promise<ListingAuthorityResult<boolean>>;
  authorizeResume(input: ResumeListingInput, context: EventStoreContext): Promise<ListingAuthorityResult<boolean>>;
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
}>;

export type AcceptedListingTargetPriceRead = Readonly<{
  listingId: string;
  target: MarketplaceListingPriceTarget;
  acceptedTargetPrice: AcceptedListingTargetPriceV1 | null;
  activationRevision: number | null;
  listingRevision: number;
  status: "draft" | "active" | "paused" | "withdrawn";
  generatedAt: string;
  sourceEventId: string;
  sourceGlobalPosition: string;
}>;

export type ListingTargetServices = Readonly<{
  acceptListingTargetPrice(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
  ): Promise<ListingTargetPriceAcceptanceResult>;
  acceptListingTargetPrices(
    input: Readonly<{ accountId: string; updates: readonly Omit<AcceptListingTargetPriceInput, "accountId">[] }>,
    context: EventStoreContext,
  ): Promise<
    readonly Readonly<{
      listingId: string;
      target: MarketplaceListingPriceTarget;
      result: ListingTargetPriceAcceptanceResult | null;
      error: string | null;
    }>[]
  >;
  activateListingForChannel(
    input: ActivateListingForChannelInput,
    context: EventStoreContext,
  ): Promise<ListingMutationResult>;
  setNativeListingVisibility(
    input: SetNativeListingVisibilityInput,
    context: EventStoreContext,
  ): Promise<ListingMutationResult>;
  resumeListing(input: ResumeListingInput, context: EventStoreContext): Promise<ListingMutationResult>;
  readAcceptedListingTargetPrices(
    input: Readonly<{
      accountId: string;
      targets: readonly Readonly<{ listingId: string; target: MarketplaceListingPriceTarget }>[];
    }>,
  ): Promise<readonly AcceptedListingTargetPriceRead[]>;
  readNativeListingEligibility(
    input: Readonly<{ accountId: string; listingIds: readonly string[] }>,
  ): Promise<readonly NativeListingEligibilityV1[]>;
}>;

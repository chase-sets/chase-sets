import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  ListingAuthorityOperation,
  ListingAuthorityPrincipal,
  ListingAuthorityParticipantPort,
  ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import type { CatalogListingAuthorityFacts } from "@chase-sets/product-measures";
import type { ListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import type { ListingEvidenceSellerFacts } from "../domain/listing-evidence-readiness";
import type { MarketplaceListingTermsPreview } from "../ui/contracts";
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
    changeSource?: "repricing-engine";
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
    inboundClamp?: import("../domain/domain").ListingInboundClampOwner;
  }>;

export type ListingMutationResult = Readonly<{ listingId: string; version: number }>;
export type ListingTargetPriceAcceptanceResult = ListingMutationResult &
  Readonly<{ acceptedTargetPrice: AcceptedListingTargetPriceV1 }>;

export type ListingAuthorityResult<T> = Readonly<{ value: T; reservations: readonly ListingAuthorityReservation[] }>;

export type ListingInventoryAuthority = Readonly<{
  accountId: string;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  availableQuantity: number;
}>;

export type ListingNativeReadinessInput = Readonly<{
  listingId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  gradedItem: boolean;
  priceAmount: string;
}>;

export type ListingNativeReadinessAuthority = Readonly<{
  listingId: string;
  accountId: string;
  productMeasureSnapshot: ProductMeasureSnapshot | null;
  /** Version of catalog.product-measures-<catalogItemId>, never a Marketplace/global position. */
  productMeasureRevision: number;
  evidenceRequirements: ListingEvidenceRequirementSnapshot | null;
  seller: ListingEvidenceSellerFacts;
}>;

export type ListingTargetAuthority = Readonly<{
  readCatalogProduct?(
    operation: ListingAuthorityOperation,
    context: EventStoreContext,
  ): Promise<ListingAuthorityResult<CatalogListingAuthorityFacts>>;
  participants: readonly ListingAuthorityParticipantPort[];
  /** Identity resolves the verified selected principal, never an audit-user role lookup. */
  resolveActor(
    input: Readonly<{ principal: ListingAuthorityPrincipal; context: EventStoreContext }>,
  ): Promise<ListingAuthorityOperation["actor"]>;
  verifyNativeFeeQuote?(
    input: Readonly<{ accountId: string; quote: MarketplaceListingTermsPreview }>,
    operation: ListingAuthorityOperation,
  ): Promise<ListingAuthorityResult<boolean>>;
  /** Current owner facts backed by reservations retained through the consuming operation's terminal fence. */
  readInventory?(
    input: Readonly<{ accountId: string; inventoryItemIds: readonly string[] }>,
    operation: ListingAuthorityOperation,
  ): Promise<readonly ListingAuthorityResult<ListingInventoryAuthority | null>[]>;
  /** Composite facts must retain each owner's reservation; Marketplace evaluates its own evidence. */
  readNativeReadiness?(
    input: Readonly<{ accountId: string; listings: readonly ListingNativeReadinessInput[]; evaluatedAt: string }>,
    operation: ListingAuthorityOperation,
  ): Promise<readonly ListingAuthorityResult<ListingNativeReadinessAuthority | null>[]>;
  authorizeManage(
    input: Readonly<{ accountId: string }>,
    context: EventStoreContext,
    operation: ListingAuthorityOperation,
  ): Promise<ListingAuthorityResult<boolean>>;
  resolveConnection(
    input: Readonly<{ accountId: string; connectionId: string }>,
    operation: ListingAuthorityOperation,
  ): Promise<
    ListingAuthorityResult<
      (NonNullable<AcceptedListingTargetPriceV1["connectionAuthority"]> & Readonly<{ accountId: string }>) | null
    >
  >;
  verifyDecision(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
    operation: ListingAuthorityOperation,
  ): Promise<ListingAuthorityResult<boolean>>;
  authorizeResume(
    input: ResumeListingInput,
    context: EventStoreContext,
    operation: ListingAuthorityOperation,
  ): Promise<ListingAuthorityResult<boolean>>;
  resolveAllocation(
    input: Readonly<{
      accountId: string;
      inventoryItemId: string;
      productId: string;
      connectionId: string;
      allocationRevision: number;
    }>,
    operation: ListingAuthorityOperation,
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
  projectionGeneration: string;
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

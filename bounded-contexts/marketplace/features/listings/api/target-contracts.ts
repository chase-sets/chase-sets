import type { ConfigurationEpochGrant } from "@chase-sets/event-core/configuration-epoch";
import type { RequestTerminalBinding, ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AcceptedListingTargetPriceV1,
  MarketplaceListingPriceDecision,
  MarketplaceListingPriceTarget,
} from "../domain/target-price";
import type { MarketplaceListingState } from "../domain/domain";

export type { AcceptedListingTargetPriceV1, MarketplaceListingPriceDecision, MarketplaceListingPriceTarget };
export class ListingTargetCommandError extends Error {
  constructor(readonly code: "connection-not-found") {
    super(code);
  }
}
export type ListingTargetPrincipal = Readonly<{
  userId: string;
  membershipId: string;
  sessionId: string;
  tokenHash: string;
}>;
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
export type ListingMutationResult = Readonly<{ listingId: string; version: number; state: MarketplaceListingState }>;
export type ListingTargetPriceAcceptanceResult = ListingMutationResult &
  Readonly<{ acceptedTargetPrice: AcceptedListingTargetPriceV1 }>;
export type ListingAuthorizationEvidence = Readonly<{
  owner: string;
  key: string;
  storeIncarnation: string;
  sealVersion: number;
  epoch?: number;
  promiseId?: string;
}>;
export type ListingConfigurationAuthority = Readonly<{
  grants: readonly ConfigurationEpochGrant[];
  evidence: readonly ListingAuthorizationEvidence[];
}>;
export type ListingPreparation = Readonly<{
  requestId: string;
  commandFingerprint: string;
  target: Readonly<Record<string, unknown>>;
}>;
export type ListingTargetAuthority = Readonly<{
  recoverRequest(preparation: ListingPreparation): Promise<void>;
  pricing?: Readonly<{
    prepare(
      request: ListingPreparation &
        Readonly<{
          input: AcceptListingTargetPriceInput &
            Readonly<{
              target: Extract<MarketplaceListingPriceTarget, { kind: "channel-connection" }>;
              decision: Extract<MarketplaceListingPriceDecision, { kind: "pricing-evaluation" }>;
            }>;
          principal: ListingTargetPrincipal;
          listing: MarketplaceListingState;
          createdAt: string;
          basePriceRevision: number;
        }>,
      context: EventStoreContext,
    ): Promise<
      Readonly<{
        terminal: RequestTerminalBinding;
        grants: readonly ConfigurationEpochGrant[];
        evidenceHash: string;
      }>
    >;
    settle(preparation: ListingPreparation, abort: boolean): Promise<void>;
  }>;
  authorizeManage(
    input: Readonly<{ accountId: string; principal: ListingTargetPrincipal }>,
    context: EventStoreContext,
  ): Promise<ListingConfigurationAuthority>;
  resolveConnection(input: Readonly<{ accountId: string; connectionId: string }>): Promise<
    ListingConfigurationAuthority &
      Readonly<{
        connection: NonNullable<AcceptedListingTargetPriceV1["connectionAuthority"]>;
      }>
  >;
  prepareAllocation(
    input: ListingPreparation &
      Readonly<{
        accountId: string;
        listingId: string;
        inventoryItemId: string;
        catalogItemId: string;
        productId: string;
        selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
        connectionId: string;
        allocationRevision: number;
      }>,
    context: EventStoreContext,
  ): Promise<
    Readonly<{
      terminal: RequestTerminalBinding;
      reservations: readonly ReserveOwnerStreamInput[];
      evidence: readonly ListingAuthorizationEvidence[];
    }>
  >;
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
    principal: ListingTargetPrincipal,
  ): Promise<ListingTargetPriceAcceptanceResult>;
  activateListingForChannel(
    input: ActivateListingForChannelInput,
    context: EventStoreContext,
    principal: ListingTargetPrincipal,
  ): Promise<ListingMutationResult>;
  readAcceptedListingTargetPrices(
    input: Readonly<{
      accountId: string;
      targets: readonly Readonly<{ listingId: string; target: MarketplaceListingPriceTarget }>[];
    }>,
  ): Promise<readonly AcceptedListingTargetPriceRead[]>;
}>;

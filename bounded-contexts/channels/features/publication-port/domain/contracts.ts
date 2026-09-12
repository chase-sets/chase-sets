import type {
  ChannelConnectionSetupDeclaration,
  ChannelConnectionSetupResolver,
  ChannelEnvironment,
} from "../../connections/domain/contracts";
import type { ExternalChannelSaleKeyV1 } from "@chase-sets/inventory/server";

export const channelExecutionModes = ["inline", "claimed"] as const;
export type ChannelExecutionMode = (typeof channelExecutionModes)[number];

export const channelPublicationRejectionCodes = [
  "validation",
  "authorization",
  "rate-limited",
  "provider-unavailable",
  "conflict",
  "not-found",
] as const;
export type ChannelPublicationRejectionCode = (typeof channelPublicationRejectionCodes)[number];

export type ChannelProviderIdentity = Readonly<{
  providerKey: string;
  environment: ChannelEnvironment;
}>;

export type ChannelPublicationPrice = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type ChannelPublicationAttribute = Readonly<{
  key: string;
  value: string;
}>;

export type ChannelPublicationDraft = Readonly<{
  channelListingId: string;
  listingRevision: number;
  title: string;
  description: string;
  categoryKey: string;
  conditionKey: string;
  price: ChannelPublicationPrice;
  quantity: number;
  attributes: readonly ChannelPublicationAttribute[];
}>;

export type PublishListingInput = Readonly<{
  operationId: string;
  connectionId: string;
  draft: ChannelPublicationDraft;
}>;

export type UpdatePriceQuantityInput = Readonly<{
  operationId: string;
  connectionId: string;
  channelListingId: string;
  listingRevision: number;
  price: ChannelPublicationPrice;
  quantity: number;
}>;

export type DelistListingInput = Readonly<{
  operationId: string;
  connectionId: string;
  channelListingId: string;
  listingRevision: number;
}>;

export type ChannelFetchBoundedUnknownReason =
  | "hard-cap"
  | "authority-total-mismatch"
  | "unsafe-next-link"
  | "duplicate-identity"
  | "missing-identity"
  | "missing-authority-total"
  | "source-error";

export type ChannelStateLineV1 = Readonly<{
  externalListingId: string;
  externalOfferId: string | null;
  revision: string;
  price: ChannelPublicationPrice;
  quantity: number;
  fingerprint: string;
}>;

export type ChannelSaleLineV1 = Readonly<{
  saleKey: ExternalChannelSaleKeyV1;
  externalListingId: string;
  externalOfferId: string | null;
  requestedQuantity: number;
  unitPriceAmount?: string;
  currencyCode?: string;
  soldAt?: string;
}>;

export type ChannelStateFetchResult =
  | Readonly<{
      kind: "complete";
      items: readonly ChannelStateLineV1[];
      collectedCount: number;
      authorityTotal: number;
      pageCount: number;
    }>
  | Readonly<{ kind: "bounded-unknown"; reason: ChannelFetchBoundedUnknownReason }>;

export type ChannelSaleFetchResult =
  | Readonly<{
      kind: "complete";
      lines: readonly ChannelSaleLineV1[];
      collectedCount: number;
      authorityTotal: number;
      pageCount: number;
    }>
  | Readonly<{ kind: "bounded-unknown"; reason: ChannelFetchBoundedUnknownReason }>;

export type ChannelPublicationSuccess = Readonly<{
  kind: "succeeded";
  externalListingId: string;
  externalOfferId?: string;
  providerRevision?: string;
}>;

export type ChannelPublicationRejection = Readonly<{
  kind: "rejected";
  code: ChannelPublicationRejectionCode;
}>;

export type ChannelPublicationResult = ChannelPublicationSuccess | ChannelPublicationRejection;

export type ChannelPublicationCapability = Readonly<
  | { execution: "claimed" }
  | {
      execution: "inline";
      publishListing(input: PublishListingInput): Promise<ChannelPublicationResult>;
      updatePriceQuantity(input: UpdatePriceQuantityInput): Promise<ChannelPublicationResult>;
      delistListing(input: DelistListingInput): Promise<ChannelPublicationResult>;
      fetchChannelState(input: Readonly<{ connectionId: string }>): Promise<ChannelStateFetchResult>;
      fetchSales(input: Readonly<{ connectionId: string; since: string }>): Promise<ChannelSaleFetchResult>;
    }
>;

export type ChannelProviderDescriptor = Readonly<{
  identity: ChannelProviderIdentity;
  setup: ChannelConnectionSetupDeclaration;
  publication?: ChannelPublicationCapability;
}>;

export type ResolvedChannelPublication = ChannelPublicationCapability;

export type ResolvedChannelProvider = Readonly<{
  identity: ChannelProviderIdentity;
  setup: ChannelConnectionSetupDeclaration;
  publication: ResolvedChannelPublication | null;
}>;

export interface ChannelProviderRegistry {
  get(identity: ChannelProviderIdentity): ResolvedChannelProvider | null;
  list(): readonly ChannelProviderIdentity[];
  readonly setupResolver: ChannelConnectionSetupResolver;
}

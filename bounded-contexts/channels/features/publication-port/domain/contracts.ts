import type {
  ChannelConnectionSetupDeclaration,
  ChannelConnectionSetupResolver,
  ChannelEnvironment,
} from "../../connections/domain/contracts";

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

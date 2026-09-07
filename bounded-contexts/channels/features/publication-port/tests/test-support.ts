import type { ChannelConnectionSetupDeclaration } from "../../connections/domain/contracts";
import type {
  ChannelProviderDescriptor,
  ChannelProviderIdentity,
  ChannelPublicationCapability,
  ChannelPublicationDraft,
  DelistListingInput,
  PublishListingInput,
  UpdatePriceQuantityInput,
} from "../domain/contracts";

export const fixtureInlineIdentity: ChannelProviderIdentity = {
  providerKey: "fixture-inline-provider",
  environment: "sandbox",
};

export const fixtureClaimedIdentity: ChannelProviderIdentity = {
  providerKey: "fixture-claimed-provider",
  environment: "production",
};

export function createFixtureSetup(identity: ChannelProviderIdentity): ChannelConnectionSetupDeclaration {
  return {
    ...identity,
    requirements: {
      credential: "not-required",
      requiredPolicyKeys: [],
      binding: "one-or-more-current",
    },
  };
}

export function createValidDraft(overrides: Partial<ChannelPublicationDraft> = {}): ChannelPublicationDraft {
  return {
    channelListingId: "fixture-listing-1",
    listingRevision: 0,
    title: "fixture-listing",
    description: "",
    categoryKey: "fixture-category",
    conditionKey: "fixture-condition",
    price: { amountMinor: 1_000, currency: "USD" },
    quantity: 1,
    attributes: [
      { key: "fixture-attribute-a", value: "first" },
      { key: "fixture-attribute-b", value: "second" },
    ],
    ...overrides,
  };
}

export function createPublishInput(overrides: Partial<PublishListingInput> = {}): PublishListingInput {
  return {
    operationId: "fixture-operation-1",
    connectionId: "fixture-connection-1",
    draft: createValidDraft(),
    ...overrides,
  };
}

export function createUpdateInput(overrides: Partial<UpdatePriceQuantityInput> = {}): UpdatePriceQuantityInput {
  return {
    operationId: "fixture-operation-2",
    connectionId: "fixture-connection-1",
    channelListingId: "fixture-listing-1",
    listingRevision: 1,
    price: { amountMinor: 1_100, currency: "USD" },
    quantity: 2,
    ...overrides,
  };
}

export function createDelistInput(overrides: Partial<DelistListingInput> = {}): DelistListingInput {
  return {
    operationId: "fixture-operation-3",
    connectionId: "fixture-connection-1",
    channelListingId: "fixture-listing-1",
    listingRevision: 2,
    ...overrides,
  };
}

export function createInlineDescriptor(
  publication: Extract<ChannelPublicationCapability, { execution: "inline" }>,
  identity: ChannelProviderIdentity = fixtureInlineIdentity,
): ChannelProviderDescriptor {
  return { identity, setup: createFixtureSetup(identity), publication };
}

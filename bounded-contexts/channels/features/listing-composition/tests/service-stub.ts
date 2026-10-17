import type { ChannelListingCompositionServices } from "../api/runtime";

export function createUnavailableListingCompositionServices(): ChannelListingCompositionServices {
  const unavailable = async (): Promise<never> => {
    throw new Error("Listing composition services were not expected.");
  };
  return {
    replaceChannelConnectionPublicationSettings: unavailable,
    recordChannelMappingCandidates: unavailable,
    decideChannelMappingReview: unavailable,
    recordChannelListingDesiredState: unavailable,
    recordChannelListingPublicationOutcome: unavailable,
    recordChannelListingPublicationOutcomeInTransaction: unavailable,
    enqueueChannelListingDesiredStateBackfill: unavailable,
    enqueueChannelListingDesiredStateReconciliation: unavailable,
    drainChannelListingDesiredStateReconciliation: unavailable,
    resolveChannelPublishableQuantity: unavailable,
    readChannelListingProviderProductReferences: unavailable,
    readChannelMappingReviewQueue: unavailable,
    listChannelPublicationConnections: unavailable,
    readChannelPublicationConnection: unavailable,
    projectors: [],
  };
}

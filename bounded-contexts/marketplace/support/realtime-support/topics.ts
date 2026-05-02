import type { RealtimeTopicManifest } from "@chase-sets/platform-runtime/realtime";

export const marketplaceRealtimeTopics = {
  accountListings: (accountId: string) => `account:${accountId}:listings`,
  accountOffers: (accountId: string) => `account:${accountId}:offers`,
} as const;

export const marketplaceRealtimeManifest = {
  contextName: "marketplace",
  topics: marketplaceRealtimeTopics,
  topicPrefixes: ["account:"],
} satisfies RealtimeTopicManifest<typeof marketplaceRealtimeTopics>;

export const marketplaceRealtimeRegistration = marketplaceRealtimeManifest;

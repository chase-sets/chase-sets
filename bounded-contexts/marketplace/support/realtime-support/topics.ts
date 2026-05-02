import type { RealtimeContextRegistration } from "@chase-sets/platform-runtime/realtime";

export const marketplaceRealtimeTopics = {
  accountListings: (accountId: string) => `account:${accountId}:listings`,
  accountOffers: (accountId: string) => `account:${accountId}:offers`,
} as const;

export const marketplaceRealtimeRegistration = {
  contextName: "marketplace",
  topicPrefixes: ["account:"],
} satisfies RealtimeContextRegistration;

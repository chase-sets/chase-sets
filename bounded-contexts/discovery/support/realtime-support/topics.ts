import type { RealtimeTopicManifest } from "@chase-sets/platform-runtime/realtime";

export const discoveryRealtimeTopics = {
  publicMarket: () => "public:market",
  item: (catalogItemId: string) => `item:${catalogItemId}`,
  listing: (listingId: string) => `listing:${listingId}`,
  seller: (accountId: string) => `seller:${accountId}`,
} as const;

export const discoveryRealtimeManifest = {
  contextName: "discovery",
  topics: discoveryRealtimeTopics,
  exactTopics: [discoveryRealtimeTopics.publicMarket()],
  topicPrefixes: ["item:", "listing:", "seller:"],
} satisfies RealtimeTopicManifest<typeof discoveryRealtimeTopics>;

export const discoveryRealtimeRegistration = discoveryRealtimeManifest;

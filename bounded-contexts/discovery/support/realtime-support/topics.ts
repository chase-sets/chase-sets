import type { RealtimeContextRegistration } from "@chase-sets/platform-runtime/realtime";

export const discoveryRealtimeTopics = {
  publicMarket: () => "public:market",
  item: (catalogItemId: string) => `item:${catalogItemId}`,
  listing: (listingId: string) => `listing:${listingId}`,
  seller: (accountId: string) => `seller:${accountId}`,
} as const;

export const discoveryRealtimeRegistration = {
  contextName: "discovery",
  exactTopics: [discoveryRealtimeTopics.publicMarket()],
  topicPrefixes: ["item:", "listing:", "seller:"],
} satisfies RealtimeContextRegistration;

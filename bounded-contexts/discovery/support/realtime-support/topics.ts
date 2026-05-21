import type { RealtimeTopicManifest, RealtimeTopicPolicyManifest } from "@chase-sets/platform-runtime/realtime";
import { createRealtimeRouteSubscriptionPreset } from "@chase-sets/platform-runtime/realtime-web";

export const discoveryRealtimeTopics = {
  publicMarket: () => "public:market",
  item: (catalogItemId: string) => `item:${catalogItemId}`,
  listing: (listingId: string) => `listing:${listingId}`,
  account: (accountId: string) => `public-account:${accountId}`,
} as const;

export const discoveryRealtimeRouteTopics = {
  search: () => createRealtimeRouteSubscriptionPreset("discovery.search", [discoveryRealtimeTopics.publicMarket()]),
  itemDetail: (catalogItemId: string) =>
    createRealtimeRouteSubscriptionPreset("discovery.itemDetail", [
      discoveryRealtimeTopics.publicMarket(),
      discoveryRealtimeTopics.item(catalogItemId),
    ]),
  publicListing: (listingId: string) =>
    createRealtimeRouteSubscriptionPreset("discovery.publicListing", [
      discoveryRealtimeTopics.publicMarket(),
      discoveryRealtimeTopics.listing(listingId),
    ]),
  publicAccount: (accountId: string) =>
    createRealtimeRouteSubscriptionPreset("discovery.publicAccount", [
      discoveryRealtimeTopics.publicMarket(),
      discoveryRealtimeTopics.account(accountId),
    ]),
} as const;

export const discoveryRealtimeManifest = {
  contextName: "discovery",
  topics: discoveryRealtimeTopics,
  exactTopics: [discoveryRealtimeTopics.publicMarket()],
  topicPrefixes: ["item:", "listing:", "public-account:"],
} satisfies RealtimeTopicManifest<typeof discoveryRealtimeTopics>;

const TOPIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const discoveryRealtimeTopicPolicyManifest = {
  contextName: "discovery",
  policies: [
    {
      name: "discovery-public-market",
      match: (topic) => (topic === discoveryRealtimeTopics.publicMarket() ? { family: "public" } : null),
      authorize: () => true,
    },
    {
      name: "discovery-public-entity",
      match: (topic) => {
        const segments = topic.split(":");
        if (
          segments.length === 2 &&
          (segments[0] === "item" || segments[0] === "listing" || segments[0] === "public-account") &&
          TOPIC_ID_PATTERN.test(segments[1] ?? "")
        ) {
          return { family: segments[0] };
        }

        return null;
      },
      authorize: () => true,
    },
  ],
} satisfies RealtimeTopicPolicyManifest;

export const discoveryRealtimeRegistration = discoveryRealtimeManifest;

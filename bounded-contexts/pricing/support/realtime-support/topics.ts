import type { RealtimeTopicManifest } from "@chase-sets/platform-runtime/realtime";

/**
 * Pricing's realtime topic registration for the market-rollups closer.
 * Pricing deliberately reuses Discovery's `item:{catalogItemId}`
 * topic namespace (bounded-contexts/discovery/support/realtime-support/topics.ts)
 * rather than minting a pricing-owned topic: the item-detail market panel
 * already opens one SSE subscription to `item:{catalogItemId}` (via
 * discoveryRealtimeRouteTopics.itemDetail), and `selectRealtimeStoresForTopics`
 * matches ANY registered context store whose topicPrefixes overlap the
 * requested topics -- reusing the topic string lets pricing's aggregate
 * patches ride the same connection without any client-side subscription
 * change. Pricing does not need its own topic-authorization policy entry:
 * Discovery's `discoveryRealtimeTopicPolicyManifest` already authorizes the
 * public `item:` pattern, and `authorizeRealtimeTopics` only requires one
 * matching policy across the composed manifest.
 */
export const pricingRealtimeTopics = {
  item: (catalogItemId: string) => `item:${catalogItemId}`,
} as const;

export const pricingRealtimeManifest = {
  contextName: "pricing",
  topics: pricingRealtimeTopics,
  topicPrefixes: ["item:"],
} satisfies RealtimeTopicManifest<typeof pricingRealtimeTopics>;

import type { RealtimeTopicManifest, RealtimeTopicPolicyManifest } from "@chase-sets/platform-runtime/realtime";
import { createRealtimeRouteSubscriptionPreset } from "@chase-sets/platform-runtime/realtime-web";

export const marketplaceRealtimeTopics = {
  accountListings: (accountId: string) => `account:${accountId}:listings`,
  accountOffers: (accountId: string) => `account:${accountId}:offers`,
  /** Seller Offer Matches carry the seller's Listings and inventory, so they stay off the buyer Offers topic. */
  accountOfferMatches: (accountId: string) => `account:${accountId}:offer-matches`,
} as const;

export const marketplaceRealtimeRouteTopics = {
  accountListings: (accountId: string) =>
    createRealtimeRouteSubscriptionPreset("marketplace.accountListings", [
      marketplaceRealtimeTopics.accountListings(accountId),
    ]),
  accountOffers: (accountId: string) =>
    createRealtimeRouteSubscriptionPreset("marketplace.accountOffers", [
      marketplaceRealtimeTopics.accountOffers(accountId),
    ]),
  accountOfferMatches: (accountId: string) =>
    createRealtimeRouteSubscriptionPreset("marketplace.accountOfferMatches", [
      marketplaceRealtimeTopics.accountOfferMatches(accountId),
    ]),
} as const;

export const marketplaceRealtimeManifest = {
  contextName: "marketplace",
  topics: marketplaceRealtimeTopics,
  topicPrefixes: ["account:"],
} satisfies RealtimeTopicManifest<typeof marketplaceRealtimeTopics>;

const TOPIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const marketplaceRealtimeTopicPolicyManifest = {
  contextName: "marketplace",
  policies: [
    {
      name: "marketplace-account-surface",
      match: (topic) => {
        const segments = topic.split(":");
        if (segments.length !== 3 || segments[0] !== "account" || !TOPIC_ID_PATTERN.test(segments[1] ?? "")) {
          return null;
        }

        if (segments[2] === "listings") {
          return { family: "account", accountId: segments[1], permissions: ["listings.view"] };
        }

        if (segments[2] === "offers") {
          return { family: "account", accountId: segments[1], permissions: ["offers.view"] };
        }

        if (segments[2] === "offer-matches") {
          return { family: "account", accountId: segments[1], permissions: ["offers.view", "listings.view"] };
        }

        return null;
      },
      authorize: (match, actor) =>
        Boolean(
          actor &&
          match.accountId === actor.accountId &&
          match.permissions?.length &&
          match.permissions.every((permission) => actor.permissions.includes(permission)),
        ),
    },
  ],
} satisfies RealtimeTopicPolicyManifest;

export const marketplaceRealtimeRegistration = marketplaceRealtimeManifest;

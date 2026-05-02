import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "./index";

export const realtimeProjectionPatchExamples = {
  discoveryMarketListingUpsert: {
    kind: "projection.patch",
    context: "discovery",
    projection: "discovery-market-projection",
    topics: ["public:market", "listing:list_1"],
    changes: [
      {
        op: "upsert",
        entity: "discovery.marketListing",
        id: "list_1",
        value: {
          listing_id: "list_1",
          item_id: "item_1",
          seller_id: "account_1",
          price_cents: 125,
        },
      },
    ],
  },
  marketplaceAccountOfferSummary: {
    kind: "projection.patch",
    context: "marketplace",
    projection: "marketplace-account-offer-projection",
    topics: ["account:account_1:offers"],
    changes: [
      {
        op: "summary",
        entity: "marketplace.accountOfferSummary",
        id: "offer_1",
        value: {
          offer_id: "offer_1",
          pending_match_count: 3,
        },
      },
    ],
  },
  discoveryListingRemove: {
    kind: "projection.patch",
    context: "discovery",
    projection: "discovery-market-projection",
    topics: ["public:market", "listing:list_1"],
    changes: [
      {
        op: "remove",
        entity: "discovery.marketListing",
        id: "list_1",
      },
    ],
  },
} as const satisfies Readonly<Record<string, RealtimeProjectionPatch>>;

export const realtimeSyncRequiredExamples = {
  cursorExpired: {
    kind: "sync.required",
    reason: "cursor-expired",
    contexts: ["discovery"],
  },
  replayBackpressure: {
    kind: "sync.required",
    reason: "replay-backpressure",
    contexts: ["marketplace"],
  },
} as const satisfies Readonly<Record<string, RealtimeSyncRequired>>;

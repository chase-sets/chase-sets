import { describe, expect, it } from "vitest";
import { resolveAgentOAuthScopedPermissions, type ResolvedActor } from "@chase-sets/auth-context";
import { authorizeRealtimeTopics } from "@chase-sets/platform-runtime/realtime";
import {
  marketplaceRealtimeRouteTopics,
  marketplaceRealtimeTopicPolicyManifest,
  marketplaceRealtimeTopics,
} from "../support/realtime-support/topics";

function sellerWith(permissions: readonly string[]): ResolvedActor {
  return {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_1",
    accountId: "acc_seller",
    membershipId: "mbr_1",
    roleKey: "owner",
    permissions,
  };
}

const authorize = (topics: readonly string[], actor: ResolvedActor | null) =>
  authorizeRealtimeTopics(topics, actor, marketplaceRealtimeTopicPolicyManifest);

describe("Marketplace Offer Match realtime topic", () => {
  const matchTopic = marketplaceRealtimeTopics.accountOfferMatches("acc_seller");
  const offersTopic = marketplaceRealtimeTopics.accountOffers("acc_seller");

  it("is separate from the buyer Offers topic and is what the Match routes subscribe to", () => {
    expect(matchTopic).toBe("account:acc_seller:offer-matches");
    expect(offersTopic).toBe("account:acc_seller:offers");
    expect(marketplaceRealtimeRouteTopics.accountOfferMatches("acc_seller").topics).toEqual([matchTopic]);
  });

  it("refuses an offers:read-only agent grant but keeps its buyer Offers topic", () => {
    const permissions = resolveAgentOAuthScopedPermissions(
      ["offers:read"],
      ["offers.view", "listings.view", "inventory.view"],
    );
    expect(permissions).toEqual(["offers.view"]);

    expect(authorize([matchTopic], sellerWith(permissions))).toBeNull();
    expect(authorize([offersTopic], sellerWith(permissions))).toEqual([offersTopic]);
  });

  it("refuses a seller with listings.view but not offers.view", () => {
    expect(authorize([matchTopic], sellerWith(["listings.view"]))).toBeNull();
  });

  it("authorizes the account's own Match topic with offers.view and listings.view", () => {
    const permissions = resolveAgentOAuthScopedPermissions(
      ["offers:read", "listings:read"],
      ["offers.view", "listings.view"],
    );

    expect(authorize([matchTopic, offersTopic], sellerWith(permissions))).toEqual([matchTopic, offersTopic]);
    expect(authorize([marketplaceRealtimeTopics.accountOfferMatches("acc_other")], sellerWith(permissions))).toBeNull();
    expect(authorize([matchTopic], null)).toBeNull();
  });
});

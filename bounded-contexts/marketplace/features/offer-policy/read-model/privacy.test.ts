import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { omitPrivateOfferResponseFields, publicOfferListResponse } from "../../offers/api/response-shape";
import { buildMarketplaceOfferProjectionHandlers } from "../../offers/read-model/projection";
import { buildBuyerOfferPolicyProjectionHandlers } from "./projection";
import type { BuyerOfferPolicyEvent } from "../domain/domain";
import { privatePolicyFields } from "../tests/fixtures";

describe("private policy serialization and projection isolation", () => {
  it("public demand, seller reads and MCP shared serializers discard policy authority", () => {
    const offer = {
      offer_id: "off_one",
      price_amount: "10.00",
      ...privatePolicyFields,
    };
    const expected = { offer_id: "off_one", price_amount: "10.00" };
    expect(omitPrivateOfferResponseFields(offer)).toEqual(expected);
    expect(publicOfferListResponse({ items: [offer], total: 1 })).toEqual({ items: [expected], total: 1 });
  });
  it("exports no policy events or membership to the outbound Channels integration", () => {
    type PrivateEvent = BuyerOfferPolicyEvent["type"] | "marketplace.offer.buyer-policy-bound";
    expectTypeOf<Extract<keyof ChaseSetsEventPayloads, PrivateEvent>>().toEqualTypeOf<never>();
    const manifest = JSON.parse(readFileSync(new URL("../../../../channels/context.json", import.meta.url), "utf8"));
    const subscriptions = manifest.eventSubscriptions.filter(
      (subscription: { sourceContextName: string }) => subscription.sourceContextName === "marketplace",
    );
    expect(subscriptions.length).toBeGreaterThan(0);
    const privateEvents = Object.keys(buildBuyerOfferPolicyProjectionHandlers({ query: vi.fn() }));
    for (const subscription of subscriptions) {
      expect(subscription.filterToEventTypes).toBe(true);
      expect(subscription.eventTypes.length).toBeGreaterThan(0);
      for (const eventType of privateEvents) expect(subscription.eventTypes).not.toContain(eventType);
    }
  });
  it("public projections see only the Offer version, never private policy authority or membership", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const publicHandlers = buildMarketplaceOfferProjectionHandlers(db);
    for (const name of Object.keys(buildBuyerOfferPolicyProjectionHandlers(db)).filter(
      (name) => name !== "marketplace.offer.buyer-policy-bound",
    ))
      expect(publicHandlers[name]).toBeUndefined();
    await publicHandlers["marketplace.offer.buyer-policy-bound"]!(
      buildTransportEvent(
        "marketplace.offer.buyer-policy-bound",
        { offerId: "off_one", policyId: "bop_private", buyerAccountId: "acc_buyer" },
        { streamVersion: 2 },
      ),
    );
    expect(db.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("SET last_stream_version = $2"), [
      "off_one",
      2,
    ]);
  });
});

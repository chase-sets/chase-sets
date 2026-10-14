import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildMarketplaceOfferProjectionHandlers } from "./projection";

describe("Offer seller-control history projection", () => {
  it("replays buyer-muted, buyer-unmuted and cooldown-bearing match-declined payloads", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [] as Row[] };
      },
    };
    const handlers = buildMarketplaceOfferProjectionHandlers(db);
    const identity = {
      sellerAccountId: "acc_seller",
      buyerAccountId: "acc_buyer",
      listingId: "lst_historical",
      productId: "cat_one::",
    };
    const mutedAt = "2026-07-05T12:00:00.000Z";
    const unmutedAt = "2026-07-05T12:02:00.000Z";
    const cooldown = "2026-07-12T12:03:00.000Z";
    await handlers["marketplace.offer.buyer-muted"]!(
      buildTransportEvent("marketplace.offer.buyer-muted", { ...identity, offerId: "off_historical", mutedAt }),
    );
    expect(calls[0]?.sql).toContain("INSERT INTO marketplace_offer_seller_controls");
    expect(calls[0]?.values).toEqual(["acc_seller", "acc_buyer", "lst_historical", "cat_one::", mutedAt]);
    calls.length = 0;
    await handlers["marketplace.offer.buyer-unmuted"]!(
      buildTransportEvent("marketplace.offer.buyer-unmuted", { ...identity, unmutedAt }),
    );
    expect(calls[0]?.sql).toContain("SET muted_at = NULL");
    expect(calls[0]?.values).toEqual(["acc_seller", "acc_buyer", "lst_historical", unmutedAt]);
    calls.length = 0;
    await handlers["marketplace.offer.match-declined"]!(
      buildTransportEvent("marketplace.offer.match-declined", {
        ...identity,
        offerId: "off_historical",
        offerPriceAmount: "2.00",
        offerPriceCurrencyCode: "USD",
        listingPriceAmount: "10.00",
        listingPriceCurrencyCode: "USD",
        declinedAt: unmutedAt,
        lowballDeclineCount: 2,
        lowballCooldownUntil: cooldown,
      }),
    );
    expect(calls[0]?.sql).toContain("INSERT INTO marketplace_offer_seller_declines");
    expect(calls[0]?.values).toEqual([
      "acc_seller",
      "acc_buyer",
      "lst_historical",
      "cat_one::",
      "off_historical",
      "2.00",
      "USD",
      "10.00",
      "USD",
      unmutedAt,
      cooldown,
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO marketplace_offer_seller_controls");
    expect(calls[1]?.values).toEqual([
      "acc_seller",
      "acc_buyer",
      "lst_historical",
      "cat_one::",
      2,
      "2.00",
      "USD",
      cooldown,
      unmutedAt,
    ]);
  });
});

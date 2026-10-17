import { describe, expect, it } from "vitest";
import { getCheckoutSellOfferMatch } from "../features/sell-list/read-model/queries";

describe("Checkout account status DB contract", () => {
  it("hides inactive buyers from Sell List Matches using the Checkout stream fence", async () => {
    const sql: string[] = [];
    const db = {
      query: async (statement: string) => {
        sql.push(statement);
        return { rows: [] };
      },
    } as never;
    await expect(getCheckoutSellOfferMatch(db, "acc_seller", "off_1")).resolves.toBeNull();
    expect(sql[0]).toContain("offer.last_stream_version > 0");
    expect(sql[0]).toContain("buyer.status = 'active'");
  });
});

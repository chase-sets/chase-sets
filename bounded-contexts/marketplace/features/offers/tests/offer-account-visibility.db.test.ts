import { describe, expect, it } from "vitest";
import { getOfferMatch, getPublicOffer } from "../read-model/queries";

describe("Offer account visibility DB contract", () => {
  it("joins the buyer mirror and applies the active-account predicate to public and Match reads", async () => {
    const sql: string[] = [];
    const db = {
      query: async (statement: string) => {
        sql.push(statement);
        return { rows: [] };
      },
    } as never;
    await expect(getPublicOffer(db, "off_1")).resolves.toBeNull();
    await expect(getOfferMatch(db, "off_1", "acc_seller")).resolves.toBeNull();
    expect(sql.join("\n")).toContain("LEFT JOIN marketplace_account_pages AS buyer");
    expect(sql.join("\n")).toContain("buyer.status = 'active'");
  });
});

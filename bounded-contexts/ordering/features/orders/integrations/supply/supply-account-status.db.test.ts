import { describe, expect, it } from "vitest";
import { getOrderingSupplyCandidateByListingId, listOrderingSupplyCandidates } from "./supply-queries";

describe("Ordering supply account status DB contract", () => {
  it("filters normal supply by active seller while allowCommitted remains unfiltered", async () => {
    const sql: string[] = [];
    const db = {
      query: async (statement: string) => {
        sql.push(statement);
        return { rows: [] };
      },
    } as never;
    const demand = {
      productId: "cat_one::",
      itemTitle: "Card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      buyerAccountId: "acc_buyer",
    } as never;
    await listOrderingSupplyCandidates(db, demand);
    await getOrderingSupplyCandidateByListingId(db, "lst_one");
    await getOrderingSupplyCandidateByListingId(db, "lst_one", { allowCommitted: true });
    expect(sql[0]).toContain("seller.status = 'active'");
    expect(sql[1]).toContain("seller.status = 'active'");
    expect(sql[2]).not.toContain("seller.status = 'active'");
  });
});

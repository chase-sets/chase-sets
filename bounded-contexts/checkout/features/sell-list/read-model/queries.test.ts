import { describe, expect, it } from "vitest";

import { getLatestSellListReceipt } from "./queries";

describe("sell list receipt queries", () => {
  it("reads only canonical execution receipts", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return {
          rows: [
            {
              seller_account_id: "acc_seller",
              execution_id: "sle_1",
              checked_out_at: "2026-06-09T00:00:00.000Z",
              execution_summary: { acceptedOfferCount: 1 },
            },
          ],
        };
      },
    };

    await expect(getLatestSellListReceipt(db, "acc_seller")).resolves.toEqual({
      seller_account_id: "acc_seller",
      execution_id: "sle_1",
      checked_out_at: "2026-06-09T00:00:00.000Z",
      execution_summary: { acceptedOfferCount: 1 },
    });
    expect(queriedSql.join("\n")).toContain("checkout_sell_list_execution_receipt_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("does not query old receipt tables when no canonical receipt exists", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getLatestSellListReceipt(db, "acc_seller")).resolves.toBeNull();
    expect(queriedSql).toHaveLength(1);
    expect(queriedSql[0]).toContain("checkout_sell_list_execution_receipt_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_receipt_pages");
  });
});

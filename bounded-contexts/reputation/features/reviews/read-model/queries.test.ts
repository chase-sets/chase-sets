import { describe, expect, it, vi } from "vitest";
import { getOrderReviewOpportunity } from "./queries";

describe("reputation review queries", () => {
  it("returns the buyer review opportunity for a verified order", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            order_id: "ord_1",
            subject_account_id: "acc_seller",
            subject_display_name: "Seller",
            author_role: "buyer",
            eligible_at: "2026-04-02T00:00:00.000Z",
            active_review_id: null,
          },
        ],
      })),
    };

    const result = await getOrderReviewOpportunity(db as never, {
      orderId: "ord_1",
      authorAccountId: "acc_buyer",
    });

    expect(result).toEqual({
      order_id: "ord_1",
      subject_account_id: "acc_seller",
      subject_display_name: "Seller",
      author_role: "buyer",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
    });
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      "ord_1",
      "acc_buyer",
    ]);
  });

  it("returns the seller review opportunity with the active review id when present", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            order_id: "ord_1",
            subject_account_id: "acc_buyer",
            subject_display_name: "Buyer",
            author_role: "seller",
            eligible_at: "2026-04-02T00:00:00.000Z",
            active_review_id: "rev_1",
          },
        ],
      })),
    };

    const result = await getOrderReviewOpportunity(db as never, {
      orderId: "ord_1",
      authorAccountId: "acc_seller",
    });

    expect(result).toEqual({
      order_id: "ord_1",
      subject_account_id: "acc_buyer",
      subject_display_name: "Buyer",
      author_role: "seller",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: "rev_1",
    });
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      "ord_1",
      "acc_seller",
    ]);
  });
});

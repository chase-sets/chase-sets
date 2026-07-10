import { describe, expect, it, vi } from "vitest";
import { buildReviewProjectionHandlers } from "./projection";

describe("marketplace review projection", () => {
  it("refreshes the unified subject account summary for seller-to-buyer reviews", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });

        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [{ subject_account_id: "acc_buyer" }] };
        }

        return { rows: [] };
      }),
    };
    const handlers = buildReviewProjectionHandlers(db as never);

    await handlers["marketplace.review.submitted"]?.({
      data: {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        authorRole: "seller",
        rating: 4,
        feedback: "Prompt payment and clear communication.",
        submittedAt: "2026-04-02T00:00:00.000Z",
      },
    } as never);
    await handlers["marketplace.review.withdrawn"]?.({
      data: {
        reviewId: "rev_1",
        withdrawnAt: "2026-04-03T00:00:00.000Z",
      },
    } as never);

    const summaryRefreshes = queries.filter((query) =>
      query.sql.includes("INSERT INTO marketplace_review_summary_pages"),
    );
    expect(summaryRefreshes).toHaveLength(2);
    expect(summaryRefreshes.map((query) => query.params[0])).toEqual(["acc_buyer", "acc_buyer"]);
    for (const refresh of summaryRefreshes) {
      expect(refresh.sql).toContain("WHERE subject_account_id = $1");
      expect(refresh.sql).toContain("AND status = 'active'");
      expect(refresh.sql).toContain("COUNT(*) FILTER (WHERE author_role = 'buyer')");
      expect(refresh.sql).toContain("COUNT(*) FILTER (WHERE author_role = 'seller')");
    }
  });
});

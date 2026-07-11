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

  it("persists the resolution-context marker on the review page without touching summary math", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        return { rows: [] };
      }),
    };
    const handlers = buildReviewProjectionHandlers(db as never);

    await handlers["marketplace.review.submitted"]?.({
      data: {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 1,
        feedback: "Refunded after the card arrived misdescribed.",
        resolutionContext: "resolved-via-refund",
        submittedAt: "2026-04-02T00:00:00.000Z",
      },
    } as never);

    const pageInsert = queries.find((query) => query.sql.includes("INSERT INTO marketplace_review_pages"));
    expect(pageInsert?.sql).toContain("resolution_context");
    expect(pageInsert?.params).toContain("resolved-via-refund");

    // Summary math is unchanged: the refresh aggregates only role, rating,
    // and status — a refund-context review is a review.
    const summaryRefresh = queries.find((query) => query.sql.includes("INSERT INTO marketplace_review_summary_pages"));
    expect(summaryRefresh).toBeDefined();
    expect(summaryRefresh?.sql).not.toContain("resolution_context");
  });

  it("stores a null resolution context for events persisted before the marker existed", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        return { rows: [] };
      }),
    };
    const handlers = buildReviewProjectionHandlers(db as never);

    await handlers["marketplace.review.submitted"]?.({
      data: {
        reviewId: "rev_legacy",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        feedback: null,
        submittedAt: "2026-04-02T00:00:00.000Z",
      },
    } as never);

    const pageInsert = queries.find((query) => query.sql.includes("INSERT INTO marketplace_review_pages"));
    expect(pageInsert?.params).toContain(null);
  });

  it("hides a submitted review from the summary until it is revealed", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [{ subject_account_id: "acc_seller" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildReviewProjectionHandlers(db as never);

    await handlers["marketplace.review.submitted"]?.({
      data: {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        feedback: "Fast shipping.",
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      },
    } as never);

    const summaryRefreshes = queries.filter((query) =>
      query.sql.includes("INSERT INTO marketplace_review_summary_pages"),
    );
    expect(summaryRefreshes).toHaveLength(1);
    expect(summaryRefreshes[0]?.sql).toContain("AND revealed_at IS NOT NULL");

    await handlers["marketplace.review.revealed"]?.({
      data: { reviewId: "rev_1", revealedAt: "2026-04-05T00:00:00.000Z", reason: "counterpart-submitted" },
    } as never);

    const revealUpdate = queries.find(
      (query) => query.sql.includes("UPDATE marketplace_review_pages") && query.sql.includes("revealed_at = $2"),
    );
    expect(revealUpdate?.params).toEqual(["rev_1", "2026-04-05T00:00:00.000Z", "counterpart-submitted"]);

    const summaryRefreshesAfterReveal = queries.filter((query) =>
      query.sql.includes("INSERT INTO marketplace_review_summary_pages"),
    );
    expect(summaryRefreshesAfterReveal).toHaveLength(2);
  });
});

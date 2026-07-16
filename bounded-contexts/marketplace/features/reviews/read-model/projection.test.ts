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
    expect(summaryRefreshes[0]?.sql).toContain("rating_contribution_status = true");

    await handlers["marketplace.review.revealed"]?.({
      data: { reviewId: "rev_1", revealedAt: "2026-04-05T00:00:00.000Z", reason: "counterpart-submitted" },
    } as never);

    const revealUpdate = queries.find(
      (query) => query.sql.includes("UPDATE marketplace_review_pages") && query.sql.includes("revealed_at = $2"),
    );
    expect(revealUpdate?.params).toEqual(["rev_1", "2026-04-05T00:00:00.000Z", "counterpart-submitted", "0"]);

    const summaryRefreshesAfterReveal = queries.filter((query) =>
      query.sql.includes("INSERT INTO marketplace_review_summary_pages"),
    );
    expect(summaryRefreshesAfterReveal).toHaveLength(2);
  });

  it("preserves ordinary historical impact and excludes legacy unattributed resolution reviews", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(
        async (sql: string, params?: readonly unknown[]) => (queries.push({ sql, params: params ?? [] }), { rows: [] }),
      ),
    };
    const handlers = buildReviewProjectionHandlers(db as never);
    const base = {
      reviewId: "rev_legacy",
      orderId: "ord_legacy",
      authorAccountId: "acc_buyer",
      subjectAccountId: "acc_seller",
      authorRole: "buyer",
      rating: 1,
      feedback: "Historical review.",
      submittedAt: "2026-04-02T00:00:00.000Z",
    };

    await handlers["marketplace.review.submitted"]?.({ data: base } as never);
    await handlers["marketplace.review.submitted"]?.({
      data: { ...base, reviewId: "rev_refund", resolutionContext: "resolved-via-refund" },
    } as never);

    const inserts = queries.filter((query) => query.sql.includes("INSERT INTO marketplace_review_pages"));
    expect(inserts[0]?.params).toEqual(expect.arrayContaining(["included", "normal-completion"]));
    expect(inserts[1]?.params).toEqual(expect.arrayContaining(["context-only", "responsibility-undetermined"]));
  });

  describe("moderation and subject reply (m108, #4269)", () => {
    it("records the operator actor and reason on a moderated withdrawal", async () => {
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

      await handlers["marketplace.review.withdrawn"]?.({
        data: {
          reviewId: "rev_1",
          withdrawnAt: "2026-04-05T00:00:00.000Z",
          actorType: "operator",
          operatorUserId: "usr_operator",
          reason: "Abusive language.",
        },
      } as never);

      const withdrawUpdate = queries.find(
        (query) =>
          query.sql.includes("UPDATE marketplace_review_pages") && query.sql.includes("withdrawn_by_actor_type"),
      );
      expect(withdrawUpdate?.params).toEqual([
        "rev_1",
        "2026-04-05T00:00:00.000Z",
        "operator",
        "usr_operator",
        "Abusive language.",
        "0",
      ]);
    });

    it("defaults the withdrawal actor to 'author' when the event carries no actor fields", async () => {
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

      await handlers["marketplace.review.withdrawn"]?.({
        data: { reviewId: "rev_1", withdrawnAt: "2026-04-05T00:00:00.000Z" },
      } as never);

      const withdrawUpdate = queries.find((query) => query.sql.includes("UPDATE marketplace_review_pages"));
      expect(withdrawUpdate?.params).toEqual(["rev_1", "2026-04-05T00:00:00.000Z", "author", null, null, "0"]);
    });

    it("redacts feedback without touching the summary aggregate", async () => {
      const queries: { sql: string; params: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
          queries.push({ sql, params: params ?? [] });
          return { rows: [] };
        }),
      };
      const handlers = buildReviewProjectionHandlers(db as never);

      await handlers["marketplace.review.feedback-redacted"]?.({
        data: {
          reviewId: "rev_1",
          redactedAt: "2026-04-05T00:00:00.000Z",
          operatorUserId: "usr_operator",
          reason: "PII in the text.",
        },
      } as never);

      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain("feedback = NULL");
      expect(queries[0]?.params).toEqual(["rev_1", "2026-04-05T00:00:00.000Z", "usr_operator", "PII in the text."]);
    });

    it("stores a submitted reply and its withdrawal", async () => {
      const queries: { sql: string; params: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
          queries.push({ sql, params: params ?? [] });
          return { rows: [] };
        }),
      };
      const handlers = buildReviewProjectionHandlers(db as never);

      await handlers["marketplace.review.reply-submitted"]?.({
        data: {
          reviewId: "rev_1",
          replyId: "rvr_1",
          feedback: "Thanks for the feedback.",
          submittedAt: "2026-04-06T00:00:00.000Z",
        },
      } as never);

      expect(queries[0]?.sql).toContain("reply_status = 'active'");
      expect(queries[0]?.params).toEqual(["rev_1", "rvr_1", "Thanks for the feedback.", "2026-04-06T00:00:00.000Z"]);

      await handlers["marketplace.review.reply-withdrawn"]?.({
        data: { reviewId: "rev_1", withdrawnAt: "2026-04-07T00:00:00.000Z" },
      } as never);

      expect(queries[1]?.sql).toContain("reply_status = 'withdrawn'");
      expect(queries[1]?.params).toEqual(["rev_1", "2026-04-07T00:00:00.000Z"]);
    });
  });
});

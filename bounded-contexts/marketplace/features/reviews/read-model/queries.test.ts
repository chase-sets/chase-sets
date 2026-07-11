import { describe, expect, it, vi } from "vitest";
import {
  findPendingCounterpartReview,
  getAccountIdBySlug,
  getAccountReview,
  getOrderReviewOpportunity,
  listPendingReviewsPastWindow,
  listPublicAccountReviews,
  listReceivedReviews,
  listWrittenReviews,
  type ReviewListRow,
} from "./queries";

function reviewRow(overrides: Partial<ReviewListRow> = {}): ReviewListRow {
  return {
    review_id: "rev_1",
    order_id: "ord_1",
    author_account_id: "acc_author",
    author_display_name: "Author",
    subject_account_id: "acc_reviewed",
    subject_display_name: "Reviewed",
    author_role: "buyer",
    rating: 5,
    feedback: "Great transaction.",
    status: "active",
    resolution_context: null,
    submitted_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    withdrawn_at: null,
    revealed_at: "2026-04-02T00:00:00.000Z",
    reveal_reason: "counterpart-submitted",
    ...overrides,
  };
}

describe("marketplace review queries", () => {
  it("returns the buyer-to-seller review opportunity for a verified order", async () => {
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
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["ord_1", "acc_buyer"]);
  });

  it("returns the seller-to-buyer review opportunity with the active review id when present", async () => {
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
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["ord_1", "acc_seller"]);
  });

  it("lists only active public reviews for an account", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "1" }] };
        }

        return {
          rows: [
            reviewRow({
              review_id: "rev_active",
            }),
          ],
        };
      }),
    };

    const result = await listPublicAccountReviews(db as never, {
      accountId: "acc_reviewed",
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    const sql = vi
      .mocked(db.query)
      .mock.calls.map(([query]) => query)
      .join("\n");
    expect(sql).toContain("WHERE subject_account_id = $1");
    expect(sql).toContain("AND status = 'active'");
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["acc_reviewed"]);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["acc_reviewed", 10, 0]);
  });

  it("keeps written and received account review lists scoped to the requested account across statuses", async () => {
    const rows = [
      reviewRow({
        review_id: "rev_active",
      }),
      reviewRow({
        review_id: "rev_withdrawn",
        order_id: "ord_2",
        author_role: "seller",
        rating: 2,
        feedback: "Withdrawn feedback.",
        status: "withdrawn",
        submitted_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
        withdrawn_at: "2026-04-04T00:00:00.000Z",
      }),
    ];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "2" }] };
        }

        return { rows };
      }),
    };

    const written = await listWrittenReviews(db as never, {
      authorAccountId: "acc_author",
      limit: 25,
      offset: 5,
    });
    const received = await listReceivedReviews(db as never, {
      subjectAccountId: "acc_reviewed",
      limit: 25,
      offset: 5,
    });

    const sql = vi
      .mocked(db.query)
      .mock.calls.map(([query]) => query)
      .join("\n");
    expect(sql).toContain("WHERE author_account_id = $1");
    expect(sql).toContain("WHERE page.author_account_id = $1");
    expect(sql).toContain("WHERE subject_account_id = $1");
    expect(sql).toContain("WHERE page.subject_account_id = $1");
    expect(sql).not.toContain("status = 'active'");
    expect(written.total).toBe(2);
    expect(written.items.map((review) => review.status)).toEqual(["active", "withdrawn"]);
    expect(received.total).toBe(2);
    expect(received.items.map((review) => review.status)).toEqual(["active", "withdrawn"]);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["acc_author", 25, 5]);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["acc_reviewed", 25, 5]);
  });

  it("loads account review details only for the author or reviewed account", async () => {
    const row = reviewRow({
      review_id: "rev_1",
      author_role: "seller",
      rating: 4,
      feedback: "Prompt payment.",
    });
    const db = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => ({
        rows: params?.[1] === "acc_author" || params?.[1] === "acc_reviewed" ? [row] : [],
      })),
    };

    await expect(getAccountReview(db as never, "rev_1", "acc_author")).resolves.toEqual(row);
    await expect(getAccountReview(db as never, "rev_1", "acc_reviewed")).resolves.toEqual(row);
    await expect(getAccountReview(db as never, "rev_1", "acc_unrelated")).resolves.toBeNull();

    const sql = vi.mocked(db.query).mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("AND (page.author_account_id = $2 OR page.subject_account_id = $2)");
    expect(sql).toContain("page.subject_account_id = $2 THEN NULL");
  });

  it("finds a not-yet-revealed counterpart review for the same order", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("AND status = 'active'");
        expect(sql).toContain("AND revealed_at IS NULL");
        expect(params).toEqual(["ord_1", "acc_seller", "acc_buyer"]);
        return { rows: [{ review_id: "rev_counterpart" }] };
      }),
    };

    const result = await findPendingCounterpartReview(db as never, {
      orderId: "ord_1",
      counterpartAuthorAccountId: "acc_seller",
      counterpartSubjectAccountId: "acc_buyer",
    });

    expect(result).toEqual({ review_id: "rev_counterpart" });
  });

  it("lists hidden reviews whose window has elapsed for the expiry sweep", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("AND revealed_at IS NULL");
        expect(sql).toContain("review_window_expires_at <= $1");
        expect(params).toEqual(["2026-06-01T00:00:00.000Z", 100]);
        return { rows: [{ review_id: "rev_expired" }] };
      }),
    };

    const result = await listPendingReviewsPastWindow(db as never, { now: "2026-06-01T00:00:00.000Z" });

    expect(result).toEqual([{ review_id: "rev_expired" }]);
  });

  it("resolves an account id from its public seller slug", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("FROM marketplace_review_account_sources");
        expect(sql).toContain("WHERE slug = $1");
        expect(params).toEqual(["card-vault-abc123"]);
        return { rows: [{ account_id: "acc_seller" }] };
      }),
    };

    const result = await getAccountIdBySlug(db as never, "card-vault-abc123");

    expect(result).toEqual("acc_seller");
  });

  it("returns null when no account matches the slug", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };

    const result = await getAccountIdBySlug(db as never, "no-such-seller");

    expect(result).toBeNull();
  });
});

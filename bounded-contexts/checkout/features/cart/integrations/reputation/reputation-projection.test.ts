import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutReputationSellerReviewsProjectionHandlers } from "./reputation-projection";

type ReviewRow = {
  review_id: string;
  subject_account_id: string;
  author_role: string;
  rating: number;
  status: string;
  last_stream_version: number;
  revealed_at: string | null;
};
type SellerAccountRow = {
  account_id: string;
  display_name: string;
  slug: string;
  average_rating: number | null;
  review_count: number;
};

/**
 * In-memory fake `PgQueryable` that interprets the reputation seller-reviews
 * projection SQL by statement shape. It maintains the auxiliary
 * `checkout_seller_account_reviews` table behind the `last_stream_version`
 * guard and the recompute that denormalizes `average_rating` (ROUND(AVG, 2))
 * and `review_count` (COUNT) over the account's `active` reviews onto the
 * `checkout_seller_accounts` join row.
 */
class ReputationProjectionDb implements PgQueryable {
  public readonly reviews = new Map<string, ReviewRow>();
  public readonly accounts = new Map<string, SellerAccountRow>();

  seedAccount(row: Partial<SellerAccountRow> & { account_id: string }): void {
    this.accounts.set(row.account_id, {
      account_id: row.account_id,
      display_name: row.display_name ?? "Card Vault",
      slug: row.slug ?? "card-vault",
      average_rating: row.average_rating ?? null,
      review_count: row.review_count ?? 0,
    });
  }

  private recompute(accountId: string): void {
    // Checkout only ever surfaces as-seller reputation: a review authored by a
    // buyer (author_role = 'buyer') is about the subject acting as a seller.
    // Double-blind reveal (m108 #4267): a hidden (not yet revealed) review
    // contributes nothing until revealed_at is set.
    const active = [...this.reviews.values()].filter(
      (review) =>
        review.subject_account_id === accountId &&
        review.status === "active" &&
        review.author_role === "buyer" &&
        review.revealed_at !== null,
    );
    const count = active.length;
    const average =
      count === 0 ? null : Math.round((active.reduce((sum, review) => sum + review.rating, 0) / count) * 100) / 100;
    const existing = this.accounts.get(accountId);
    if (existing) {
      existing.average_rating = average;
      existing.review_count = count;
    } else {
      this.accounts.set(accountId, {
        account_id: accountId,
        display_name: "",
        slug: "",
        average_rating: average,
        review_count: count,
      });
    }
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_seller_account_reviews")) {
      const reviewId = String(values[0]);
      const subjectAccountId = String(values[1]);
      const authorRole = String(values[2]);
      const rating = Number(values[3]);
      const streamVersion = Number(values[4]);
      const existing = this.reviews.get(reviewId);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.reviews.set(reviewId, {
          review_id: reviewId,
          subject_account_id: subjectAccountId,
          author_role: authorRole,
          rating,
          status: "active",
          last_stream_version: streamVersion,
          revealed_at: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE checkout_seller_account_reviews") && sql.includes("revealed_at = $2")) {
      const reviewId = String(values[0]);
      const revealedAt = String(values[1]);
      const streamVersion = Number(values[2]);
      const existing = this.reviews.get(reviewId);
      if (existing && existing.revealed_at === null && existing.last_stream_version < streamVersion) {
        existing.revealed_at = revealedAt;
        existing.last_stream_version = streamVersion;
        return { rows: [{ subject_account_id: existing.subject_account_id }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("UPDATE checkout_seller_account_reviews") && sql.includes("rating = $2")) {
      const reviewId = String(values[0]);
      const rating = Number(values[1]);
      const streamVersion = Number(values[3]);
      const existing = this.reviews.get(reviewId);
      if (existing && existing.last_stream_version < streamVersion) {
        existing.rating = rating;
        existing.last_stream_version = streamVersion;
        return { rows: [{ subject_account_id: existing.subject_account_id }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("UPDATE checkout_seller_account_reviews") && sql.includes("status = 'withdrawn'")) {
      const reviewId = String(values[0]);
      const streamVersion = Number(values[2]);
      const existing = this.reviews.get(reviewId);
      if (existing && existing.last_stream_version < streamVersion) {
        existing.status = "withdrawn";
        existing.last_stream_version = streamVersion;
        return { rows: [{ subject_account_id: existing.subject_account_id }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO checkout_seller_accounts") && sql.includes("FROM checkout_seller_account_reviews")) {
      const accountId = String(values[0]);
      this.recompute(accountId);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, streamVersion: number, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: "marketplace.review-rev_1" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-17T00:00:00.000Z" as never,
      recordedAt: "2026-06-17T00:00:00.000Z" as never,
    },
  };
}

describe("checkout reputation seller-reviews projection", () => {
  it("hides a submitted review from the aggregate until it is revealed (m108 #4267)", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_1",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );

    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: null, review_count: 0 });

    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_1",
        revealedAt: "2026-06-18T00:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );

    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 5, review_count: 1 });

    // Idempotent / stream-ordering guard: an already-revealed review ignores a
    // later reveal attempt with an equal-or-lower stream version.
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_1",
        revealedAt: "2026-06-19T00:00:00.000Z",
        reason: "window-expired",
      }),
    );
    expect(db.reviews.get("rev_1")?.revealed_at).toBe("2026-06-18T00:00:00.000Z");
  });

  it("recomputes average_rating and review_count on review.submitted", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_1",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_2",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 4,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_1",
        revealedAt: "2026-06-17T01:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_2",
        revealedAt: "2026-06-17T01:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );

    // ROUND(AVG(5, 4), 2) = 4.5, COUNT = 2.
    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 4.5, review_count: 2 });
  });

  it("counts only as-seller reviews (author_role = 'buyer'), excluding reviews earned as a buyer", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_dual_role" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    // 2 reviews earned as a seller (authored by buyers).
    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_seller_1",
        subjectAccountId: "acc_dual_role",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_seller_2",
        subjectAccountId: "acc_dual_role",
        authorRole: "buyer",
        rating: 3,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_seller_1",
        revealedAt: "2026-06-17T01:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_seller_2",
        revealedAt: "2026-06-17T01:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );
    // 10 reviews earned as a buyer (authored by sellers) must NOT blend in.
    for (let index = 0; index < 10; index += 1) {
      await handlers["marketplace.review.submitted"]!(
        event("marketplace.review.submitted", 1, {
          reviewId: `rev_buyer_${index}`,
          subjectAccountId: "acc_dual_role",
          authorRole: "seller",
          rating: 1,
          submittedAt: "2026-06-17T00:00:00.000Z",
        }),
      );
      await handlers["marketplace.review.revealed"]!(
        event("marketplace.review.revealed", 2, {
          reviewId: `rev_buyer_${index}`,
          revealedAt: "2026-06-17T01:00:00.000Z",
          reason: "counterpart-submitted",
        }),
      );
    }

    // Buyer-facing checkout only ever shows the 2-review seller rating.
    expect(db.accounts.get("acc_dual_role")).toMatchObject({ average_rating: 4, review_count: 2 });
  });

  it("recomputes the rounded average when a review rating is updated", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_1",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_2",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 2,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    // Updates only happen pre-reveal in the real domain.
    await handlers["marketplace.review.updated"]!(
      event("marketplace.review.updated", 2, {
        reviewId: "rev_2",
        rating: 4,
        updatedAt: "2026-06-17T01:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 3, {
        reviewId: "rev_1",
        revealedAt: "2026-06-17T02:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 3, {
        reviewId: "rev_2",
        revealedAt: "2026-06-17T02:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );

    // ROUND(AVG(5, 4), 2) = 4.5.
    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 4.5, review_count: 2 });
  });

  it("drops a withdrawn review from the average and count, nulling the rating at zero reviews", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_1",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.withdrawn"]!(
      event("marketplace.review.withdrawn", 2, {
        reviewId: "rev_1",
        withdrawnAt: "2026-06-17T02:00:00.000Z",
      }),
    );

    // No active reviews left → rating null, count 0 (graceful empty state).
    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: null, review_count: 0 });
  });

  it("is replay-safe: replaying submit/update/withdraw converges to the same recompute", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller" });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    const submit = event("marketplace.review.submitted", 1, {
      reviewId: "rev_1",
      subjectAccountId: "acc_seller",
      authorRole: "buyer",
      rating: 3,
      submittedAt: "2026-06-17T00:00:00.000Z",
    });
    const update = event("marketplace.review.updated", 2, {
      reviewId: "rev_1",
      rating: 5,
      updatedAt: "2026-06-17T01:00:00.000Z",
    });

    await handlers["marketplace.review.submitted"]!(submit);
    await handlers["marketplace.review.updated"]!(update);
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 3, {
        reviewId: "rev_1",
        revealedAt: "2026-06-17T02:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );

    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 5, review_count: 1 });

    // Replaying the older submit (stream version 1) must not regress the rating
    // applied by the newer update (stream version 2): the guard ignores it.
    await handlers["marketplace.review.submitted"]!(submit);

    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 5, review_count: 1 });
  });

  it("records reputation onto an account row that is not projected yet", async () => {
    const db = new ReputationProjectionDb();
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", 1, {
        reviewId: "rev_1",
        subjectAccountId: "acc_late",
        authorRole: "buyer",
        rating: 4,
        submittedAt: "2026-06-17T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", 2, {
        reviewId: "rev_1",
        revealedAt: "2026-06-17T01:00:00.000Z",
        reason: "counterpart-submitted",
      }),
    );

    // The identity handler can backfill display_name/slug later; reputation only
    // owns the rating counters.
    expect(db.accounts.get("acc_late")).toMatchObject({ average_rating: 4, review_count: 1 });
  });

  it("ignores update/withdraw for an unknown review id", async () => {
    const db = new ReputationProjectionDb();
    db.seedAccount({ account_id: "acc_seller", average_rating: 4.5, review_count: 2 });
    const handlers = buildCheckoutReputationSellerReviewsProjectionHandlers(db);

    await handlers["marketplace.review.updated"]!(
      event("marketplace.review.updated", 9, {
        reviewId: "rev_missing",
        rating: 1,
        updatedAt: "2026-06-17T03:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.withdrawn"]!(
      event("marketplace.review.withdrawn", 9, {
        reviewId: "rev_missing",
        withdrawnAt: "2026-06-17T03:00:00.000Z",
      }),
    );

    // Seeded counters are untouched because the review was never recorded.
    expect(db.accounts.get("acc_seller")).toMatchObject({ average_rating: 4.5, review_count: 2 });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../../index";
import { buildSettlementReputationAccountRiskSourceProjectionHandlers } from "./account-risk-source-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function reviewSubmittedEvent(data: {
  reviewId: string;
  orderId: string;
  authorAccountId: string;
  subjectAccountId: string;
  authorRole: "buyer" | "seller";
  rating: number;
  submittedAt: string;
}): TransportEvent {
  return buildTransportEvent("marketplace.review.submitted", data, {
    id: "evt_1",
    streamId: `marketplace.review-${data.reviewId}`,
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: data.authorAccountId },
    timing: { occurredAt: data.submittedAt, recordedAt: data.submittedAt },
  });
}

function reviewWithdrawnEvent(data: { reviewId: string; withdrawnAt: string }): TransportEvent {
  return buildTransportEvent("marketplace.review.withdrawn", data, {
    id: "evt_2",
    streamId: `marketplace.review-${data.reviewId}`,
    streamVersion: 2,
    globalPosition: "2",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    timing: { occurredAt: data.withdrawnAt, recordedAt: data.withdrawnAt },
  });
}

function reviewRevealedEvent(data: { reviewId: string; revealedAt: string }): TransportEvent {
  return buildTransportEvent(
    "marketplace.review.revealed",
    {
      reviewId: data.reviewId,
      revealedAt: data.revealedAt,
      reason: "counterpart-submitted",
    },
    {
      id: "evt_3",
      streamId: `marketplace.review-${data.reviewId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: data.revealedAt, recordedAt: data.revealedAt },
    },
  );
}

describeDb("settlement account risk source review-role SQL persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "risk_review_role");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("counts an as-seller review (author acted as buyer) toward the subject's payout-risk review_count", async () => {
    const handlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(pool);
    await seedTrustSignal({ orderId: "ord_1", sellerAccountId: "acc_seller", eligible: true });

    await handlers["marketplace.review.submitted"]!(
      reviewSubmittedEvent({
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        submittedAt: "2026-07-08T00:00:00.000Z",
      }),
    );

    // Double-blind reveal (m108 #4267): hidden until revealed -- must not move
    // payout risk before reveal.
    await expect(getRisk("acc_seller")).resolves.toEqual(
      expect.objectContaining({ review_count: 0, average_rating: null }),
    );

    await handlers["marketplace.review.revealed"]!(
      reviewRevealedEvent({ reviewId: "rev_1", revealedAt: "2026-07-09T00:00:00.000Z" }),
    );

    await expect(getRisk("acc_seller")).resolves.toEqual(
      expect.objectContaining({ review_count: 1, average_rating: "5.00" }),
    );
  });

  it("does not count an as-buyer review (author acted as seller) toward the subject's payout-risk review_count", async () => {
    const handlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(pool);
    // acc_buyer is the buyer of ord_2; acc_seller_2 authored this review while acting
    // as the seller, so subject acc_buyer was reviewed AS A BUYER. This must not move
    // acc_buyer's payout-risk review_count no matter what a heavy buying history looks like.
    await seedTrustSignal({ orderId: "ord_2", sellerAccountId: "acc_seller_2", eligible: true });

    await handlers["marketplace.review.submitted"]!(
      reviewSubmittedEvent({
        reviewId: "rev_2",
        orderId: "ord_2",
        authorAccountId: "acc_seller_2",
        subjectAccountId: "acc_buyer",
        authorRole: "seller",
        rating: 5,
        submittedAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    // Reveal it too: the exclusion below must be because of the author_role
    // filter, not merely because the review is still hidden.
    await handlers["marketplace.review.revealed"]!(
      reviewRevealedEvent({ reviewId: "rev_2", revealedAt: "2026-07-09T00:00:00.000Z" }),
    );

    await expect(getRisk("acc_buyer")).resolves.toEqual(
      expect.objectContaining({ review_count: 0, average_rating: null }),
    );
  });

  it("excludes a buyer-role review by author_role alone, even if the trust-signal seller happens to match the subject", async () => {
    // Defensive case: construct a row that satisfies the m107 trust-signal join
    // (trust_source.seller_account_id === subject_account_id for the same order)
    // but carries author_role = 'seller' (an as-buyer review for the subject).
    // This cannot occur through the real domain (self-review is blocked), but it
    // proves the new author_role filter is load-bearing on its own, independent
    // of the trust-signal join's incidental seller/order pairing.
    const handlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(pool);
    await seedTrustSignal({ orderId: "ord_3", sellerAccountId: "acc_mixed", eligible: true });

    await handlers["marketplace.review.submitted"]!(
      reviewSubmittedEvent({
        reviewId: "rev_3",
        orderId: "ord_3",
        authorAccountId: "acc_other",
        subjectAccountId: "acc_mixed",
        authorRole: "seller",
        rating: 3,
        submittedAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      reviewRevealedEvent({ reviewId: "rev_3", revealedAt: "2026-07-09T00:00:00.000Z" }),
    );

    await expect(getRisk("acc_mixed")).resolves.toEqual(
      expect.objectContaining({ review_count: 0, average_rating: null }),
    );
  });

  it("excludes a trust-signal-ineligible as-seller review, composing the m107 and m108 filters", async () => {
    const handlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(pool);
    await seedTrustSignal({ orderId: "ord_4", sellerAccountId: "acc_seller", eligible: false });

    await handlers["marketplace.review.submitted"]!(
      reviewSubmittedEvent({
        reviewId: "rev_4",
        orderId: "ord_4",
        authorAccountId: "acc_buyer_2",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 4,
        submittedAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      reviewRevealedEvent({ reviewId: "rev_4", revealedAt: "2026-07-09T00:00:00.000Z" }),
    );

    await expect(getRisk("acc_seller")).resolves.toEqual(
      expect.objectContaining({ review_count: 0, average_rating: null }),
    );
  });

  it("recomputes the as-seller review_count after an as-seller review is withdrawn", async () => {
    const handlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(pool);
    await seedTrustSignal({ orderId: "ord_5", sellerAccountId: "acc_seller", eligible: true });

    await handlers["marketplace.review.submitted"]!(
      reviewSubmittedEvent({
        reviewId: "rev_5",
        orderId: "ord_5",
        authorAccountId: "acc_buyer_3",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 2,
        submittedAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.revealed"]!(
      reviewRevealedEvent({ reviewId: "rev_5", revealedAt: "2026-07-08T12:00:00.000Z" }),
    );
    await expect(getRisk("acc_seller")).resolves.toEqual(expect.objectContaining({ review_count: 1 }));

    await handlers["marketplace.review.withdrawn"]!(
      reviewWithdrawnEvent({ reviewId: "rev_5", withdrawnAt: "2026-07-09T00:00:00.000Z" }),
    );

    await expect(getRisk("acc_seller")).resolves.toEqual(
      expect.objectContaining({ review_count: 0, average_rating: null }),
    );
  });

  async function seedTrustSignal(params: { orderId: string; sellerAccountId: string; eligible: boolean }) {
    await pool.query(
      `INSERT INTO settlement_order_trust_signal_sources (
         order_id,
         seller_account_id,
         trust_signal_eligible,
         updated_at
       ) VALUES ($1, $2, $3, $4)`,
      [params.orderId, params.sellerAccountId, params.eligible, "2026-07-08T00:00:00.000Z"],
    );
  }

  async function getRisk(accountId: string) {
    const result = await pool.query<{ review_count: number; average_rating: string | null }>(
      `SELECT review_count, average_rating::text AS average_rating
       FROM settlement_account_risk_sources
       WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0] ?? { review_count: 0, average_rating: null };
  }
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for settlement account risk source review-role DB tests.");
  }

  return databaseBaseUrl;
}

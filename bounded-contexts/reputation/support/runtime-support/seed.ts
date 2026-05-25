import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { reputationReservedSeedIds } from "@chase-sets/reputation/seed-support/ids";
import { createReputationServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";

function createSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId as never,
    },
  };
}

async function drainProjectors(projectors: readonly ProjectionHandlerSet[]) {
  void projectors;
}

export async function seedReputationDatabase(pool: PgTransactionalPool) {
  const services = createReputationServices(pool);

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM reputation_review_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Reputation already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  await drainProjectors(services.projectors);

  const buyerToSellerOpportunity = await services.reviews.getOrderReviewOpportunity(
    (
      await services.db.query<{ order_id: string }>(
        `SELECT order_id
         FROM reputation_review_eligibility_pages
         WHERE author_account_id = $1
         ORDER BY eligible_at ASC, order_id ASC
         LIMIT 1`,
        [identitySeedIds.collector.accountId],
      )
    ).rows[0]?.order_id ?? "",
    identitySeedIds.collector.accountId,
  );

  if (!buyerToSellerOpportunity) {
    throw new Error("Reputation seed requires buyer-to-seller review eligibility from a delivered shipment.");
  }

  const sellerToBuyerOpportunity = await services.reviews.getOrderReviewOpportunity(
    buyerToSellerOpportunity.order_id,
    identitySeedIds.demo.accountId,
  );

  if (!sellerToBuyerOpportunity) {
    throw new Error("Reputation seed requires seller-to-buyer review eligibility from a delivered shipment.");
  }

  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.buyerToSellerActive,
      orderId: buyerToSellerOpportunity.order_id as never,
      authorAccountId: identitySeedIds.collector.accountId,
      subjectAccountId: buyerToSellerOpportunity.subject_account_id as never,
      authorRole: buyerToSellerOpportunity.author_role as never,
      rating: 4,
      feedback: "Packed well and shipped exactly as described.",
      submittedAt: "2026-03-23T09:00:00.000Z",
    },
    context: createSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId),
  });
  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "UpdateReview",
      rating: 5,
      feedback: "Packed well, shipped quickly, and matched the listing.",
      updatedAt: "2026-03-23T10:00:00.000Z",
    },
    context: createSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId),
  });

  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn,
      orderId: sellerToBuyerOpportunity.order_id as never,
      authorAccountId: identitySeedIds.demo.accountId,
      subjectAccountId: sellerToBuyerOpportunity.subject_account_id as never,
      authorRole: sellerToBuyerOpportunity.author_role as never,
      rating: 3,
      feedback: "Responsive but asked for extra packing photos.",
      submittedAt: "2026-03-23T09:15:00.000Z",
    },
    context: createSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId),
  });
  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "WithdrawReview",
      withdrawnAt: "2026-03-23T10:15:00.000Z",
    },
    context: createSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId),
  });

  await drainProjectors(services.projectors);
}

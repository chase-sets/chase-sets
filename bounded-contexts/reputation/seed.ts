import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds, reputationReservedSeedIds } from "@chase-sets/dev-seeds";
import { createReputationServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";

function createSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId as never,
    },
  };
}

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function seedReputationDatabase(pool: PgTransactionalPool) {
  const services = createReputationServices(pool);

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM reputation_review_pages",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Reputation already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  await drainProjectors(services.projectors);

  const buyerOpportunity = await services.reviews.getOrderReviewOpportunity(
    (
      await services.db.query<{ order_id: string }>(
        `SELECT order_id
         FROM reputation_review_eligibility_pages
         WHERE author_account_id = $1
         ORDER BY eligible_at ASC, order_id ASC
         LIMIT 1`,
        [identitySeedIds.buyer.accountId],
      )
    ).rows[0]?.order_id ?? "",
    identitySeedIds.buyer.accountId,
  );

  if (!buyerOpportunity) {
    throw new Error("Reputation seed requires buyer review eligibility from a delivered shipment.");
  }

  const sellerOpportunity = await services.reviews.getOrderReviewOpportunity(
    buyerOpportunity.order_id,
    identitySeedIds.seller.accountId,
  );

  if (!sellerOpportunity) {
    throw new Error("Reputation seed requires seller review eligibility from a delivered shipment.");
  }

  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.buyerToSellerActive,
      orderId: buyerOpportunity.order_id as never,
      authorAccountId: identitySeedIds.buyer.accountId,
      subjectAccountId: buyerOpportunity.subject_account_id as never,
      authorRole: buyerOpportunity.author_role as never,
      rating: 4,
      feedback: "Packed well and shipped exactly as described.",
      submittedAt: "2026-03-23T09:00:00.000Z",
    },
    context: createSeedContext(identitySeedIds.buyer.accountId, identitySeedIds.buyer.userId),
  });
  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "UpdateReview",
      rating: 5,
      feedback: "Packed well, shipped quickly, and matched the listing.",
      updatedAt: "2026-03-23T10:00:00.000Z",
    },
    context: createSeedContext(identitySeedIds.buyer.accountId, identitySeedIds.buyer.userId),
  });

  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn,
      orderId: sellerOpportunity.order_id as never,
      authorAccountId: identitySeedIds.seller.accountId,
      subjectAccountId: sellerOpportunity.subject_account_id as never,
      authorRole: sellerOpportunity.author_role as never,
      rating: 3,
      feedback: "Responsive but asked for extra packing photos.",
      submittedAt: "2026-03-23T09:15:00.000Z",
    },
    context: createSeedContext(identitySeedIds.seller.accountId, identitySeedIds.seller.userId),
  });
  await services.reviews.commandHandler({
    streamId: `reputation.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "WithdrawReview",
      withdrawnAt: "2026-03-23T10:15:00.000Z",
    },
    context: createSeedContext(identitySeedIds.seller.accountId, identitySeedIds.seller.userId),
  });

  await drainProjectors(services.projectors);
}

import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { orderingReservedSeedIds } from "@chase-sets/ordering/seed-support/ids";
import type { AccountId, OrderId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { supportSeedIds } from "../seed-support/ids";
import { createSupportServices, type SupportServices } from "./services";

type SupportSeedOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
}>;

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

async function supportRequestExists(services: SupportServices, supportRequestId: string) {
  const result = await services.db.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM support_request_pages
       WHERE support_request_id = $1
     ) AS exists`,
    [supportRequestId],
  );

  return result.rows[0]?.exists ?? false;
}

async function loadSeedOrderSource(
  services: SupportServices,
): Promise<SupportSeedOrderSource> {
  const result = await services.db.query<SupportSeedOrderSource>(
    `SELECT order_id, buyer_account_id, seller_account_id, status
     FROM support_order_sources
     WHERE order_id = $1`,
    [orderingReservedSeedIds.orders.acceptedOfferReady],
  );
  const order = result.rows[0];
  if (!order) {
    throw new Error(
      `Support seed requires order source '${orderingReservedSeedIds.orders.acceptedOfferReady}' to be projected before support seeding runs.`,
    );
  }

  return order;
}

export async function seedSupportDatabase(
  pool: PgTransactionalPool,
  support: SupportServices = createSupportServices(pool),
): Promise<void> {
  try {
    const seededCount = await support.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE support_request_id = ANY($1::text[])`,
      [
        [
          supportSeedIds.supportRequests.activeProductNotReceived,
          supportSeedIds.supportRequests.resolvedPartialRefund,
        ],
      ],
    );
    if (Number(seededCount.rows[0]?.count ?? 0) === 2) {
      console.log("Support already contains seed data. Skipping seed.");
      return;
    }
  } catch {
    // Tables may not exist yet. Proceed with seeding.
  }

  const order = await loadSeedOrderSource(support);
  const buyerContext = createSeedContext(
    identitySeedIds.collector.accountId,
    identitySeedIds.collector.userId,
  );
  const supportContext = createSeedContext(
    identitySeedIds.demo.accountId,
    identitySeedIds.demo.userId,
  );

  if (
    !(await supportRequestExists(
      support,
      supportSeedIds.supportRequests.activeProductNotReceived,
    ))
  ) {
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.activeProductNotReceived}`,
      command: {
        type: "OpenSupportRequest",
        supportRequestId:
          supportSeedIds.supportRequests.activeProductNotReceived as SupportRequestId,
        orderId: order.order_id as OrderId,
        buyerAccountId: order.buyer_account_id as AccountId,
        sellerAccountId: order.seller_account_id as AccountId,
        flowType: "product-not-received",
        openedByAccountId: order.buyer_account_id as AccountId,
        openedByRole: "buyer",
        openedAt: "2026-03-25T09:00:00.000Z",
      },
      context: buyerContext,
    });
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.activeProductNotReceived}`,
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: supportSeedIds.evidence.activeBuyerAttestation,
        submittedByAccountId: order.buyer_account_id as AccountId,
        submittedByRole: "buyer",
        evidenceType: "buyer-attestation",
        summary: "Buyer reports the order has not arrived.",
        submittedAt: "2026-03-25T09:02:00.000Z",
      },
      context: buyerContext,
    });
  }

  if (
    !(await supportRequestExists(
      support,
      supportSeedIds.supportRequests.resolvedPartialRefund,
    ))
  ) {
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.resolvedPartialRefund}`,
      command: {
        type: "OpenSupportRequest",
        supportRequestId:
          supportSeedIds.supportRequests.resolvedPartialRefund as SupportRequestId,
        orderId: order.order_id as OrderId,
        buyerAccountId: order.buyer_account_id as AccountId,
        sellerAccountId: order.seller_account_id as AccountId,
        flowType: "product-damaged",
        openedByAccountId: order.buyer_account_id as AccountId,
        openedByRole: "buyer",
        openedAt: "2026-03-25T10:00:00.000Z",
      },
      context: buyerContext,
    });
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.resolvedPartialRefund}`,
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: supportSeedIds.evidence.resolvedBuyerAttestation,
        submittedByAccountId: order.buyer_account_id as AccountId,
        submittedByRole: "buyer",
        evidenceType: "buyer-attestation",
        summary: "Buyer reports edge wear from shipping damage.",
        submittedAt: "2026-03-25T10:02:00.000Z",
      },
      context: buyerContext,
    });
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.resolvedPartialRefund}`,
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: supportSeedIds.evidence.resolvedPhoto,
        submittedByAccountId: order.buyer_account_id as AccountId,
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Photo evidence shows the damaged corner.",
        submittedAt: "2026-03-25T10:04:00.000Z",
        attachments: ["seed://support/damaged-card-corner"],
      },
      context: buyerContext,
    });
    await support.supportRequests.commandHandler({
      streamId: `support.support-request-${supportSeedIds.supportRequests.resolvedPartialRefund}`,
      command: {
        type: "ResolveSupportRequest",
        resolutionType: "partial-refund",
        summary: "Seeded support partial refund for shipping damage.",
        refundAmount: "5.00",
        resolvedByAccountId: identitySeedIds.demo.accountId,
        resolvedAt: "2026-03-25T10:30:00.000Z",
      },
      context: supportContext,
    });
  }

  await drainProjectors(support.projectors);
}

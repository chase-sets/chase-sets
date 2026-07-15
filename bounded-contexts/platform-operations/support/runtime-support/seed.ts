import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { AccountId, OrderId, SupportRequestId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createPlatformOperationsServices, type PlatformOperationsServices } from "./services";
import { ExperienceDomainError } from "../../features/platform-feedback/domain/common";
import { SupportDomainError } from "../../features/support-requests/domain/common";
import {
  SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
  supportDeadlinePolicy,
} from "../../features/support-requests/domain/support-deadline-policy";
import {
  PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
  platformRemedyPolicy,
} from "../../features/support-requests/domain/platform-remedy-policy";
import { experienceSeedIds, supportSeedIds, supportSeedOrderSourceIds } from "../seed-support/ids";

function isoDate(value: string) {
  return new Date(value).toISOString();
}

export async function seedPlatformOperationsDatabase(
  pool: PgTransactionalPool,
  services: PlatformOperationsServices = createPlatformOperationsServices(pool),
): Promise<void> {
  await seedSupportDeadlinePolicy(services);
  await seedPlatformRemedyPolicy(services);
  await seedPlatformFeedbackData(pool, services);
  await seedSupportDatabase(pool, services);
}

async function seedPlatformRemedyPolicy(services: PlatformOperationsServices) {
  try {
    await seedPolicyDocumentIfMissing(
      services,
      createSeedContext(),
      platformRemedyPolicy,
      PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      "2026-07-14T00:00:00.000Z",
    );
  } catch (error) {
    console.log(
      `Platform remedy policy seed skipped for this pass: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Seeds the support-deadline policy with the launch value (single-sourced
 * from the compiled flow catalog) before any support-request seed activity
 * below -- behavior must be byte-identical at cutover. Failures here are
 * non-fatal to the rest of the seed pass (matching the resilience of the
 * "table may not exist yet" guards elsewhere in this file): a fresh
 * bootstrap where the platform-policy tables have not landed yet must not
 * block support-request seed data that later passes depend on.
 */
async function seedSupportDeadlinePolicy(services: PlatformOperationsServices) {
  try {
    await seedPolicyDocumentIfMissing(
      services,
      createSeedContext(),
      supportDeadlinePolicy,
      SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "2026-01-01T00:00:00.000Z",
    );
  } catch (error) {
    console.log(
      `Support deadline policy seed skipped for this pass: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createSeedContext(): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId as UserId,
      forAccountId: identitySeedIds.demo.accountId as AccountId,
    },
  };
}

/**
 * Seeds a platform-policy document with the launch value so behavior is
 * byte-identical at cutover: the compiled fallback and this seeded document
 * agree on every value. A policy document's id is assigned by the
 * platform-policy machinery itself (not pre-registered), so idempotency is
 * checked against the policy key rather than a fixed seed id.
 */
async function seedPolicyDocumentIfMissing<Value>(
  services: PlatformOperationsServices,
  context: EventStoreContext,
  definition: PolicyDefinition<Value>,
  value: Value,
  effectiveFrom: string,
) {
  if (await policyDocumentExists(services.db, definition.policyKey)) {
    return;
  }

  await services.policies.createPolicyDocument(
    definition,
    {
      value,
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
      actorUserId: identitySeedIds.demo.userId,
    },
    context,
  );
}

async function policyDocumentExists(db: Pick<PgTransactionalPool, "query">, policyKey: string): Promise<boolean> {
  try {
    const existing = await db.query(
      "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1",
      [policyKey],
    );
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}

export async function seedPlatformFeedbackData(
  pool: PgTransactionalPool,
  services: PlatformOperationsServices = createPlatformOperationsServices(pool),
) {
  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM experience_platform_feedback_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Platform feedback already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = {
    tenantId: "tnt_seed_demo" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId as UserId,
      forAccountId: identitySeedIds.demo.accountId as AccountId,
    },
    trace: {},
  };
  const samples = [
    {
      feedbackId: experienceSeedIds.checkout,
      userId: identitySeedIds.collector.userId,
      accountId: identitySeedIds.collector.accountId,
      rating: 5,
      topic: "checkout-payment" as const,
      comment: "Checkout totals were clear before payment.",
      followUpConsent: false,
      workflow: "checkout-payment" as const,
      sourceRoutePath: "/account/payments/pay_seed_checkout",
      relatedEntities: [{ type: "payment", id: "pay_seed_checkout" }],
      submittedAt: isoDate("2026-05-04T15:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.listing,
      userId: identitySeedIds.cardVault.userId,
      accountId: identitySeedIds.cardVault.accountId,
      rating: 4,
      topic: "pricing-fees" as const,
      comment: "The fee preview helped, but comparing net proceeds still takes focus.",
      followUpConsent: true,
      workflow: "listing-publish" as const,
      sourceRoutePath: "/account/listings/lst_seed_card_vault",
      relatedEntities: [{ type: "listing", id: "lst_seed_card_vault" }],
      submittedAt: isoDate("2026-05-05T16:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.offer,
      userId: identitySeedIds.valueTrader.userId,
      accountId: identitySeedIds.valueTrader.accountId,
      rating: 3,
      topic: "ease-of-use" as const,
      comment: "Offer tracking is useful, but the next expected step could be clearer.",
      followUpConsent: true,
      workflow: "offer-submit" as const,
      sourceRoutePath: "/account/offers/submitted/off_seed_value",
      relatedEntities: [{ type: "offer", id: "off_seed_value" }],
      submittedAt: isoDate("2026-05-06T17:00:00.000Z"),
    },
    {
      feedbackId: experienceSeedIds.inventory,
      userId: identitySeedIds.sealedStockroom.userId,
      accountId: identitySeedIds.sealedStockroom.accountId,
      rating: 4,
      topic: "selling-inventory" as const,
      comment: "Adding stock was direct. Bulk import will matter soon.",
      followUpConsent: false,
      workflow: "inventory-create" as const,
      sourceRoutePath: "/account/inventory",
      relatedEntities: [{ type: "inventory-item", id: "inv_seed_box" }],
      submittedAt: isoDate("2026-05-07T18:00:00.000Z"),
    },
  ];

  for (const sample of samples) {
    try {
      await services.platformFeedback.commandHandler({
        streamId: `platform-operations.platform-feedback-${sample.feedbackId}`,
        command: {
          type: "SubmitPlatformFeedback",
          ...sample,
        },
        context,
      });
    } catch (error) {
      // Seed passes can repeat before the feedback projection catches up,
      // so the table-count guard above can miss already-submitted streams.
      if (error instanceof ExperienceDomainError) {
        console.log(`Platform feedback ${sample.feedbackId} already submitted. Skipping.`);
        continue;
      }
      throw error;
    }
  }
}

type SupportSeedOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
  total_amount: string;
}>;

function createSupportSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
  };
}

async function supportRequestExists(services: PlatformOperationsServices, supportRequestId: string) {
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

async function loadSeedOrderSource(services: PlatformOperationsServices): Promise<SupportSeedOrderSource | null> {
  const reservedOrder = await services.db.query<SupportSeedOrderSource>(
    `SELECT order_id, buyer_account_id, seller_account_id, status, total_amount::text AS total_amount
     FROM support_order_sources
     WHERE order_id = $1`,
    [supportSeedOrderSourceIds.acceptedOfferReady],
  );
  const order = reservedOrder.rows[0];
  if (!order) {
    // Seed orders identify by ready_for_fulfillment_at (the payments seed
    // fixes it via payment-capture timestamps): support targets the
    // earliest-ready order, never the latest-ready review-eligible order,
    // because opening a support request deletes the review eligibility the
    // marketplace reviews seed depends on.
    const reconciledOrder = await services.db.query<SupportSeedOrderSource>(
      `SELECT order_id, buyer_account_id, seller_account_id, status, total_amount::text AS total_amount
       FROM support_order_sources
       WHERE buyer_account_id = $1
         AND seller_account_id = $2
         AND status = 'ready-for-fulfillment'
       ORDER BY ready_for_fulfillment_at ASC NULLS LAST, order_id ASC
       LIMIT 1`,
      [identitySeedIds.collector.accountId, identitySeedIds.demo.accountId],
    );
    const fallbackOrder = reconciledOrder.rows[0];
    if (fallbackOrder) {
      return fallbackOrder;
    }

    console.log(
      `Support seed is waiting for order source ${supportSeedOrderSourceIds.acceptedOfferReady}. Skipping support requests for this pass.`,
    );
    return null;
  }

  return order;
}

export async function seedSupportDatabase(
  pool: PgTransactionalPool,
  support: PlatformOperationsServices = createPlatformOperationsServices(pool),
): Promise<void> {
  try {
    const seededCount = await support.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE support_request_id = ANY($1::text[])`,
      [[supportSeedIds.supportRequests.activeProductNotReceived, supportSeedIds.supportRequests.resolvedPartialRefund]],
    );
    if (Number(seededCount.rows[0]?.count ?? 0) === 2) {
      console.log("Support already contains seed data. Skipping seed.");
      return;
    }
  } catch {
    // Tables may not exist yet. Proceed with seeding.
  }

  const order = await loadSeedOrderSource(support);
  if (!order) {
    return;
  }
  const buyerContext = createSupportSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const supportContext = createSupportSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  // Seed passes can repeat before the support projection catches up, so the
  // exists guards can miss already-opened streams; the domain duplicate error
  // marks a block as already seeded.
  try {
    if (!(await supportRequestExists(support, supportSeedIds.supportRequests.activeProductNotReceived))) {
      await support.supportRequests.commandHandler({
        streamId: `support.support-request-${supportSeedIds.supportRequests.activeProductNotReceived}`,
        command: {
          type: "OpenSupportRequest",
          supportRequestId: supportSeedIds.supportRequests.activeProductNotReceived as SupportRequestId,
          orderId: order.order_id as OrderId,
          orderTotalAmount: order.total_amount,
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
  } catch (error) {
    if (error instanceof SupportDomainError) {
      console.log("Support request active-product-not-received already seeded. Skipping.");
    } else {
      throw error;
    }
  }

  try {
    if (!(await supportRequestExists(support, supportSeedIds.supportRequests.resolvedPartialRefund))) {
      await support.supportRequests.commandHandler({
        streamId: `support.support-request-${supportSeedIds.supportRequests.resolvedPartialRefund}`,
        command: {
          type: "OpenSupportRequest",
          supportRequestId: supportSeedIds.supportRequests.resolvedPartialRefund as SupportRequestId,
          orderId: order.order_id as OrderId,
          orderTotalAmount: order.total_amount,
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
          responsibility: "carrier",
          evidenceBasis: {
            type: "operator-finding",
            reference: "support-seed.operator-adjudication.v1",
          },
          responsibilityReasonCode: "product-damaged.carrier-damage",
          resolvedByAccountId: identitySeedIds.demo.accountId,
          resolvedByRole: "support",
          resolvedAt: "2026-03-25T10:30:00.000Z",
        },
        context: supportContext,
      });
    }
  } catch (error) {
    if (error instanceof SupportDomainError) {
      console.log("Support request resolved-partial-refund already seeded. Skipping.");
    } else {
      throw error;
    }
  }
}

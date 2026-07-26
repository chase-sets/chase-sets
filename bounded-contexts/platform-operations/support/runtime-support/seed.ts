import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedStreamEvents } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { AccountId, OrderId, SupportRequestId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createPlatformOperationsServices, type PlatformOperationsServices } from "./services";
import {
  evolvePlatformFeedback,
  initialPlatformFeedbackState,
  type PlatformFeedbackEvent,
} from "../../features/platform-feedback/domain/domain";
import {
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestEvent,
  type SupportRequestState,
} from "../../features/support-requests/domain/domain";
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

  // Each sample is decided on its own `platform-operations.platform-feedback-*`
  // stream. `experience_platform_feedback_pages` is UNLOGGED, so the projection
  // count this replaced could report an empty table while the logged streams
  // still held every submission; the previous code covered that by catching and
  // discarding the domain duplicate error, which also hid genuine conflicts.
  for (const sample of samples) {
    if ((await loadSeedPlatformFeedbackState(services.db, sample.feedbackId)).feedbackId !== null) {
      continue;
    }
    await services.platformFeedback.commandHandler({
      streamId: platformFeedbackStreamId(sample.feedbackId),
      command: {
        type: "SubmitPlatformFeedback",
        ...sample,
      },
      context,
    });
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

const PLATFORM_OPERATIONS_BOOTSTRAP_LABEL = "Platform Operations seed bootstrap";

const platformFeedbackStreamId = (feedbackId: string) => `platform-operations.platform-feedback-${feedbackId}`;
const supportRequestStreamId = (supportRequestId: string) => `support.support-request-${supportRequestId}`;

async function loadSeedPlatformFeedbackState(db: PgQueryable, feedbackId: string) {
  const committed = await loadSeedStreamEvents<PlatformFeedbackEvent>(db, platformFeedbackStreamId(feedbackId));
  return committed.reduce(evolvePlatformFeedback, initialPlatformFeedbackState);
}

/**
 * Folds one seeded support request from its own `support.support-request-*`
 * stream.
 *
 * `support_request_pages` is UNLOGGED, so PostgreSQL truncates it on crash
 * recovery while the logged streams survive. The projection-sourced guard this
 * replaced counted three reserved rows as one all-or-nothing verdict and then
 * relied on catching the domain duplicate error per block; each request is now
 * decided, and resumed, on its own committed events.
 */
async function loadSeedSupportRequestState(db: PgQueryable, supportRequestId: string) {
  const committed = await loadSeedStreamEvents<SupportRequestEvent>(db, supportRequestStreamId(supportRequestId));
  return { committed, state: committed.reduce(evolveSupportRequest, initialSupportRequestState) };
}

const seededSupportRequestInventory = [
  {
    supportRequestId: supportSeedIds.supportRequests.activeProductNotReceived,
    key: "active-product-not-received",
    flowType: "product-not-received",
    openedAt: "2026-03-25T09:00:00.000Z",
    evidence: [
      {
        evidenceId: supportSeedIds.evidence.activeBuyerAttestation,
        evidenceType: "buyer-attestation",
        summary: "Buyer reports the order has not arrived.",
        submittedAt: "2026-03-25T09:02:00.000Z",
        attachments: null,
      },
    ],
    resolution: null,
  },
  {
    supportRequestId: supportSeedIds.supportRequests.selfServiceProductDamaged,
    key: "self-service-product-damaged",
    flowType: "product-damaged",
    openedAt: "2026-07-15T09:00:00.000Z",
    evidence: [
      {
        evidenceId: supportSeedIds.evidence.selfServiceBuyerAttestation,
        evidenceType: "buyer-attestation",
        summary: "Buyer reports that the item arrived with a damaged corner.",
        submittedAt: "2026-07-15T09:02:00.000Z",
        attachments: null,
      },
      {
        evidenceId: supportSeedIds.evidence.selfServicePhoto,
        evidenceType: "photo",
        summary: "Photos show the damaged item and package corner.",
        submittedAt: "2026-07-15T09:04:00.000Z",
        attachments: ["seed://support/self-service-damaged-corner"],
      },
    ],
    resolution: null,
  },
  {
    supportRequestId: supportSeedIds.supportRequests.resolvedPartialRefund,
    key: "resolved-partial-refund",
    flowType: "product-damaged",
    openedAt: "2026-03-25T10:00:00.000Z",
    evidence: [
      {
        evidenceId: supportSeedIds.evidence.resolvedBuyerAttestation,
        evidenceType: "buyer-attestation",
        summary: "Buyer reports edge wear from shipping damage.",
        submittedAt: "2026-03-25T10:02:00.000Z",
        attachments: null,
      },
      {
        evidenceId: supportSeedIds.evidence.resolvedPhoto,
        evidenceType: "photo",
        summary: "Photo evidence shows the damaged corner.",
        submittedAt: "2026-03-25T10:04:00.000Z",
        attachments: ["seed://support/damaged-card-corner"],
      },
    ],
    resolution: {
      summary: "Seeded support partial refund for shipping damage.",
      refundAmount: "5.00",
      resolvedAt: "2026-03-25T10:30:00.000Z",
    },
  },
] as const satisfies readonly Readonly<{
  supportRequestId: string;
  key: string;
  flowType: "product-not-received" | "product-damaged";
  openedAt: string;
  evidence: readonly Readonly<{
    evidenceId: string;
    evidenceType: "buyer-attestation" | "photo";
    summary: string;
    submittedAt: string;
    attachments: readonly string[] | null;
  }>[];
  resolution: Readonly<{ summary: string; refundAmount: string; resolvedAt: string }> | null;
}>[];

/**
 * Evidence already committed to a support request, read from the folded
 * aggregate rather than from the projection. `support.support-request.
 * evidence-submitted` nests its id under `evidence`, so folding is also the
 * only reading that stays correct if that payload shape changes.
 */
function committedEvidenceIds(state: SupportRequestState): readonly string[] {
  return state.evidence.map((entry) => String(entry.evidenceId));
}

/**
 * Reports the Platform Operations seed's base aggregate state from the
 * authoritative streams: every reserved platform-feedback submission and every
 * reserved support request.
 */
export async function inspectPlatformOperationsSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const [key, feedbackId] of Object.entries(experienceSeedIds)) {
    const committed = await loadSeedStreamEvents<PlatformFeedbackEvent>(pool, platformFeedbackStreamId(feedbackId));
    const state = committed.reduce(evolvePlatformFeedback, initialPlatformFeedbackState);
    reports.push({
      contextName: "platform-operations",
      aggregateName: "Platform Feedback",
      id: feedbackId,
      key,
      streamId: platformFeedbackStreamId(feedbackId),
      kind: state.feedbackId === null ? "absent" : "active",
      status: state.feedbackId === null ? null : "submitted",
      eventCount: committed.length,
    });
  }

  for (const request of seededSupportRequestInventory) {
    const { committed, state } = await loadSeedSupportRequestState(pool, request.supportRequestId);
    const evidence = committedEvidenceIds(state);
    const evidenceComplete = request.evidence.every((entry) => evidence.includes(entry.evidenceId));
    const complete =
      state.supportRequestId !== null &&
      evidenceComplete &&
      (request.resolution === null || state.status === "resolved");
    reports.push({
      contextName: "platform-operations",
      aggregateName: "Support Request",
      id: request.supportRequestId,
      key: request.key,
      streamId: supportRequestStreamId(request.supportRequestId),
      kind: state.supportRequestId === null ? "absent" : complete ? "active" : "draft",
      status: state.supportRequestId === null ? null : String(state.status),
      eventCount: committed.length,
    });
  }

  return reports;
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
  const order = await loadSeedOrderSource(support);
  if (!order) {
    return;
  }
  const buyerContext = createSupportSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const supportContext = createSupportSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  for (const request of seededSupportRequestInventory) {
    await reconcileSeedSupportRequest(support, request, order, buyerContext, supportContext);
  }
}

type SeededSupportRequest = (typeof seededSupportRequestInventory)[number];

/**
 * Resumes one seeded support request from its own committed stream. Opening,
 * each piece of evidence, and the resolution are separate decisions, so an
 * interrupted seed continues from where the stream stops instead of relying on
 * a swallowed duplicate-create error.
 */
async function reconcileSeedSupportRequest(
  support: PlatformOperationsServices,
  request: SeededSupportRequest,
  order: SupportSeedOrderSource,
  buyerContext: EventStoreContext,
  supportContext: EventStoreContext,
): Promise<void> {
  const streamId = supportRequestStreamId(request.supportRequestId);
  const { state } = await loadSeedSupportRequestState(support.db, request.supportRequestId);

  if (state.supportRequestId !== null && String(state.orderId) !== String(order.order_id)) {
    throw new Error(
      `${PLATFORM_OPERATIONS_BOOTSTRAP_LABEL} Support Request '${request.key}' expected order ` +
        `'${order.order_id}', but found '${state.orderId ?? "null"}'. Stream '${streamId}'.`,
    );
  }

  if (state.supportRequestId === null) {
    await support.supportRequests.commandHandler({
      streamId,
      command: {
        type: "OpenSupportRequest",
        supportRequestId: request.supportRequestId as SupportRequestId,
        orderId: order.order_id as OrderId,
        orderTotalAmount: order.total_amount,
        buyerAccountId: order.buyer_account_id as AccountId,
        sellerAccountId: order.seller_account_id as AccountId,
        flowType: request.flowType,
        openedByAccountId: order.buyer_account_id as AccountId,
        openedByRole: "buyer",
        openedAt: request.openedAt,
      },
      context: buyerContext,
    });
  }

  const alreadySubmitted = committedEvidenceIds(state);
  for (const evidence of request.evidence) {
    if (alreadySubmitted.includes(evidence.evidenceId)) {
      continue;
    }
    await support.supportRequests.commandHandler({
      streamId,
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: evidence.evidenceId,
        submittedByAccountId: order.buyer_account_id as AccountId,
        submittedByRole: "buyer",
        evidenceType: evidence.evidenceType,
        summary: evidence.summary,
        submittedAt: evidence.submittedAt,
        ...(evidence.attachments ? { attachments: [...evidence.attachments] } : {}),
      },
      context: buyerContext,
    });
  }

  if (request.resolution && state.status !== "resolved") {
    await support.supportRequests.commandHandler({
      streamId,
      command: {
        type: "ResolveSupportRequest",
        resolutionType: "partial-refund",
        summary: request.resolution.summary,
        refundAmount: request.resolution.refundAmount,
        responsibility: "carrier",
        evidenceBasis: {
          type: "operator-finding",
          reference: "support-seed.operator-adjudication.v1",
        },
        responsibilityReasonCode: "product-damaged.carrier-damage",
        resolvedByAccountId: identitySeedIds.demo.accountId,
        resolvedByRole: "support",
        resolvedAt: request.resolution.resolvedAt,
      },
      context: supportContext,
    });
  }
}

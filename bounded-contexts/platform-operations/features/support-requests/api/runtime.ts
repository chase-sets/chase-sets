import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import { canonicalParticipantRequest, parseParticipantAttempt } from "../domain/participant-attempt";
import {
  createParticipantRuntime,
  participantOpenSupportRequestId,
  type ParticipantCommandInput,
  type ParticipantLookupInput,
  type PrepareSupportEvidence,
} from "./participant-runtime";
import type { ParticipantLookup, ParticipantResult } from "../domain/participant-attempt";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { decideEvidenceAccess, type EvidenceAccessAction } from "../domain/evidence-access-policy";
import { createEvidenceAccessAudit, EvidenceAccessError, type EvidenceAccessAuditPage } from "./evidence-access-audit";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { compareMoneyAmounts } from "@chase-sets/primitives/money";
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, CoverageId, OrderId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeEvidenceType,
  normalizeFlowType,
  normalizeRequesterRole,
  normalizeResolutionType,
  normalizeResponseType,
  normalizeRequiredText,
  assertSupportEvidenceReferences,
  isSupportEvidenceSeedContext,
  SupportDomainError,
  type SupportEvidenceType,
  type SupportAffectedLineItemAmount,
  type SupportFlowType,
  type SupportOrderReturnContextLine,
  type SupportRequesterRole,
  type SupportResolutionType,
  type SupportResponsibility,
  type SupportEvidenceBasis,
  type SupportResponsibilityReasonCode,
  type SupportResponseType,
} from "../domain/common";
import {
  decideSupportRequest,
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestCommand,
  type SupportRequestEvent,
  type SupportRequestState,
} from "../domain/domain";
import { getSupportFlowDefinition, supportFlowCatalog, type SupportFlowDefinition } from "../domain/flow-catalog";
import { sellerSilenceResponsibilityFact } from "../domain/responsibility";
import { resolveSupportFlowDeadlineHours, supportDeadlinePolicy } from "../domain/support-deadline-policy";
import { normalizeRemedyAuthorization } from "../domain/remedy";
import type { OverrideSupportRemedyEffectCommand, RecordSupportRemedyEffectCommand } from "../domain/remedy";
import type {
  ApproveSupportRemedyCommand,
  ProposeSupportRemedyCommand,
  RequestSupportRemedyCorrectionCommand,
  RetrySupportRemedyEffectCommand,
} from "../domain/remedy-approval";
import {
  assertRemedyPolicyLimit,
  PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
  platformRemedyCapabilities,
  platformRemedyPolicy,
  platformRemedyPolicyVersion,
  strongestRemedyPolicyAuthority,
  type PlatformRemedyCapability,
  type PlatformRemedyPolicyValue,
} from "../domain/platform-remedy-policy";
import {
  buildSupportRequestTransactionalEmailProjectionHandlers,
  SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import { buildSupportRequestProjectionHandlers } from "../read-model/projection";
import {
  readSupportEvidenceAttachment,
  SupportEvidenceAttachmentError,
  storeSupportEvidenceAttachments,
  type StoredSupportEvidenceAttachment,
  type SupportEvidenceAttachmentStorage,
  type SupportEvidenceAttachmentUpload,
} from "./attachments";
import { validateSupportAttachmentOperationId } from "./attachment-intake";
import {
  assertSupportEvidenceCleanupCapability,
  createSupportEvidenceCleanupRunner,
  requestSupportAttachmentCleanup,
  type SupportEvidenceCleanupCapability,
  type SupportEvidenceCleanupRunner,
} from "./attachment-cleanup";
import {
  buildSupportEvidenceCleanupLocatorHandlers,
  supportEvidenceCleanupLocatorProjection,
} from "../read-model/cleanup-locator";
import type { SupportEvidenceCanonicalizationQueue } from "./evidence-canonicalization";
import { parseSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
import {
  attachmentManifestReferences,
  attachmentOperationStreamId,
  canonicalJson,
  decideAttachmentOperation,
  hasUnsettledAttachmentPut,
  replayAttachmentOperation,
  type AttachmentOperationOwner,
  type AttachmentOperationEvent,
  type AttachmentReferenceClaim,
} from "../domain/attachment-operation";
import {
  findOpenSupportRequestForOrder,
  getAccountSupportRequest,
  getSupportOperationsRequest,
  listSupportOperationsQueue,
  listBuyerSupportRequests,
  listSellerSupportRequests,
  listSupportRequestsAwaitingReturnDelivery,
  listSupportRequestsNeedingResponseReminder,
  listSupportRequestsNeedingReviewReminder,
  listSupportRequestsOverdueForEscalation,
  listSupportRequestsPastSellerResponseDeadline,
  listSupportRequestsReadyForAutoClose,
  listSupportRequestsReadyForReturnRefundRelease,
} from "../read-model/queries";

type SupportRequestRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationOutbox?: NotificationOutbox;
  attachmentStorage?: SupportEvidenceAttachmentStorage;
  attachmentCanonicalizer?: SupportEvidenceCanonicalizationQueue;
  /** The worker's binding-scoped cleanup capability; absent means not mounted. */
  attachmentCleanup?: SupportEvidenceCleanupCapability;
  /**
   * The shared platform-policy runtime, used to resolve the support-deadline
   * policy at open time and to source `listFlowDefinitions`' response-window
   * display copy from the same live values. Optional so seeds and any
   * pre-policy call site keep working against the flow catalog's compiled
   * defaults unchanged.
   */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
  now?: () => string;
}>;

type SupportRequestMutationScope = "participant" | "operations";

export type SupportOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
  total_amount: string;
  delivered_at: string | null;
  return_context: readonly SupportOrderReturnContextLine[];
  affected_line_amounts: readonly SupportAffectedLineItemAmount[];
}>;

export type SupportOrderContext = Readonly<{
  orderId: string;
  openedByRole: "buyer" | "seller";
  status: string;
  totalAmount: string;
  lines: readonly Readonly<{
    lineId: string;
    itemTitle: string;
    productSummary: string | null;
    quantity: number;
    amount: string;
    currencyCode: string;
  }>[];
  existingOpenRequest?: Readonly<{
    supportRequestId: string;
    displayReference: string;
    flowType: string;
    status: string;
  }>;
}>;

export type PlatformRemedyTermsInput = Readonly<{
  remedy: ProposeSupportRemedyCommand["terms"]["remedy"];
  allocation: ProposeSupportRemedyCommand["terms"]["allocation"];
  returnDirective: ProposeSupportRemedyCommand["terms"]["returnDirective"] | string;
  refundTrigger: ProposeSupportRemedyCommand["terms"]["refundTrigger"] | string;
  reasonCode: string;
  returnExceptionReasonCode?: string | null;
}>;

export type PlatformRemedyProposalPreview = Readonly<{
  customerOutcome: string;
  sellerImpact: string;
  protectionReserveImpact: string;
  returnLabelCostPayer: "seller" | "platform" | "not-applicable";
  refundTrigger: string;
  reservationExpiresAt: string | null;
  requiredApprovalCount: number;
  requiresElevatedApproval: boolean;
  returnOverrideRequired: boolean;
  policyVersion: string;
}>;

function normalizeOrderId(value: string): OrderId {
  const orderId = normalizeRequiredText(value, "Order is required.");
  try {
    return parseTypedId(orderId, "ord");
  } catch {
    throw new SupportDomainError("Expected an order ID starting with ord_.");
  }
}

function deterministicSupportId(prefix: "sup" | "sev", sourceReference: string): string {
  const digest = createHash("sha256").update(sourceReference, "utf8").digest("hex").slice(0, 26);
  return `${prefix}_${digest}`;
}

export type SupportRequestServices = Readonly<{
  stageParticipantIntakeAttachments: (
    params: Readonly<{
      attemptId: string;
      orderId: string;
      flowType: string;
      affectedLineIds: readonly string[] | null;
      operationId: string;
      actor: ResolvedActor;
      uploads: () => Promise<readonly SupportEvidenceAttachmentUpload[]>;
    }>,
  ) => Promise<readonly StoredSupportEvidenceAttachment[]>;
  executeParticipantAttempt: (input: ParticipantCommandInput, context: EventStoreContext) => Promise<ParticipantResult>;
  getParticipantAttempt: (input: ParticipantLookupInput) => Promise<ParticipantLookup>;
  commandHandler: CommandHandler<SupportRequestCommand, SupportRequestState, SupportRequestEvent>;
  /**
   * The flow catalog with each flow's `sellerResponseHours`/
   * `supportReviewHours` overridden by the support-deadline policy's current
   * resolved value (falls back to the compiled catalog default when no
   * `policies` dependency is wired). This is the single source both the
   * marketplace "before you open a request" panel and any future
   * public-policy copy read -- so displayed windows and enforced deadlines
   * can never diverge.
   */
  listFlowDefinitions: () => Promise<readonly SupportFlowDefinition[]>;
  resolveSupportFlowDefinition: (flowType: SupportFlowType) => Promise<SupportFlowDefinition>;
  openSupportRequest: (
    params: Readonly<{
      orderId: string;
      accountId: string;
      flowType: SupportFlowType | string;
      affectedLineIds?: readonly string[] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  openAutomatedSellerCannotFulfillRequest: (
    params: Readonly<{
      orderId: string;
      sellerAccountId: string;
      reservationRequestId: string;
      holdId: string;
      releasedAt: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  getSupportOrderContext: (params: Readonly<{ orderId: string; accountId: string }>) => Promise<SupportOrderContext>;
  uploadAttachments: (
    params: Readonly<{
      supportRequestId: string;
      operationId: string;
      actor: ResolvedActor | null;
      uploads: () => Promise<readonly SupportEvidenceAttachmentUpload[]>;
    }>,
  ) => Promise<readonly StoredSupportEvidenceAttachment[]>;
  getAttachment: (
    params: Readonly<{
      supportRequestId: string;
      attachmentId: string;
      actor: ResolvedActor | null;
    }>,
  ) => Promise<Readonly<{ body: Uint8Array; contentType: string }> | null>;
  getEvidenceAccessAudit: (
    params: Readonly<{ supportRequestId: string; actor: ResolvedActor | null; cursor?: string }>,
  ) => Promise<EvidenceAccessAuditPage>;
  /** Records CleanupRequired for a human request; the worker's bound runner alone claims and deletes. */
  requestAttachmentCleanup: (
    params: Readonly<{ supportRequestId: string; operationId: string; actor: ResolvedActor | null }>,
  ) => ReturnType<typeof requestSupportAttachmentCleanup>;
  /** Present only when a valid, active cleanup binding mounted the capability. */
  attachmentCleanup:
    | Readonly<{ kind: "not-mounted" }>
    | Readonly<{ kind: "available"; initialize: () => Promise<unknown>; run: SupportEvidenceCleanupRunner }>;
  submitEvidence: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      submittedByRole: SupportRequesterRole | string;
      evidenceType: SupportEvidenceType | string;
      summary: string;
      occurredAt?: string | null;
      attachments?: readonly string[];
      attachmentOperationId?: string;
      scope?: SupportRequestMutationScope;
      actor?: ResolvedActor | null;
    }>,
    context: EventStoreContext | undefined,
  ) => Promise<{ supportRequestId: string; version: number }>;
  recordResponse: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      submittedByRole: SupportRequesterRole | string;
      responseType: SupportResponseType | string;
      summary: string;
      offerResolutionType?: SupportResolutionType | string | null;
      refundAmount?: string | null;
      affectedLineIds?: readonly string[] | null;
      refundCurrencyCode?: string | null;
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  acceptOffer: (
    params: Readonly<{ supportRequestId: string; accountId: string; offerId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  declineOffer: (
    params: Readonly<{ supportRequestId: string; accountId: string; offerId: string; summary?: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  escalateSupportRequest: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      reason: string;
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  resolveSupportRequest: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      resolutionType: SupportResolutionType | string;
      summary: string;
      refundAmount?: string | null;
      affectedLineIds?: readonly string[] | null;
      refundCurrencyCode?: string | null;
      responsibility: SupportResponsibility | string;
      evidenceBasis: Readonly<{ type: SupportEvidenceBasis["type"] | string; reference: string }>;
      responsibilityReasonCode: SupportResponsibilityReasonCode | string;
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  previewRemedyProposal: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      permissions: readonly string[];
      terms: PlatformRemedyTermsInput;
      at?: string;
    }>,
  ) => Promise<PlatformRemedyProposalPreview>;
  proposeRemedy: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      permissions: readonly string[];
      terms: PlatformRemedyTermsInput;
      rationale: string;
      evidenceReferences: readonly string[];
      idempotencyKey: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number; status: string }>;
  approveRemedy: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      permissions: readonly string[];
      reasonCode: string;
      rationale: string;
      evidenceReferences: readonly string[];
      idempotencyKey: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number; status: string }>;
  retryRemedyEffect: (
    params: Omit<RetrySupportRemedyEffectCommand, "type" | "requestedByAccountId" | "permissionUsed" | "requestedAt"> &
      Readonly<{ supportRequestId: string; accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number }>;
  requestRemedyCorrection: (
    params: Omit<
      RequestSupportRemedyCorrectionCommand,
      "type" | "requestedByAccountId" | "permissionUsed" | "requestedAt"
    > &
      Readonly<{ supportRequestId: string; accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number }>;
  recordRemedyEffect: (
    params: Omit<RecordSupportRemedyEffectCommand, "type"> & Readonly<{ supportRequestId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number }>;
  overrideRemedyEffect: (
    params: Omit<OverrideSupportRemedyEffectCommand, "type" | "actorAccountId" | "permissionUsed" | "overriddenAt"> &
      Readonly<{ supportRequestId: string; accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; remedyId: string; version: number }>;
  closeSupportRequest: (
    params: Readonly<{ supportRequestId: string; accountId: string; scope?: SupportRequestMutationScope }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  cancelSupportRequest: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      reason: string;
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  escalateOverdueSupportRequests: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<{ escalated: number; skipped: number; capped: boolean; total: number }>;
  /**
   * Records that a `return-for-refund` case's returned item arrived back.
   * Starts the 5-day inspection window; the refund releases automatically
   * once it elapses unless the seller disputes the item's condition.
   */
  recordReturnDelivery: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      deliveredAt?: string;
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  /**
   * The seller's structured dispute of the returned item's condition,
   * recorded within the inspection window. Blocks the automatic release;
   * only a support-scoped `releaseReturnRefund` call can move it forward.
   */
  disputeReturnCondition: (
    params: Readonly<{ supportRequestId: string; accountId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  /**
   * Support-only manual override: releases a pending return refund from
   * either `awaiting-return-inspection` or `return-condition-disputed`
   * without waiting for the automatic deadline.
   */
  releaseReturnRefund: (
    params: Readonly<{ supportRequestId: string; accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  listSupportRequestsAwaitingReturnDelivery: (
    params: Parameters<typeof listSupportRequestsAwaitingReturnDelivery>[1],
  ) => ReturnType<typeof listSupportRequestsAwaitingReturnDelivery>;
  /**
   * The scheduled deadline sweep: auto-resolves seller-silence cases to
   * their flow default, escalates contested/overdue cases and
   * silence cases whose default cannot be safely applied, emits SLA reminder
   * events, auto-closes resolved cases after 7 days, and releases
   * `return-for-refund` refunds once the 5-day return-inspection window
   * elapses without a seller condition dispute. Every state change
   * is a domain event with a system actor (`resolvedByRole`/`escalatedByRole`
   * `null`), never a silent row update. Safe to run concurrently: each
   * candidate mutation goes through the same optimistic-concurrency command
   * handler as the manual admin actions, so a duplicate attempt from an
   * overlapping sweep either finds the case already past the guarded status
   * (no-op) or loses the append race.
   */
  sweepSupportRequestDeadlines: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<SupportRequestDeadlineSweepResult>;
  listSupportOperationsQueue: (
    params: Parameters<typeof listSupportOperationsQueue>[1],
  ) => ReturnType<typeof listSupportOperationsQueue>;
  listBuyerSupportRequests: (
    params: Parameters<typeof listBuyerSupportRequests>[1],
  ) => ReturnType<typeof listBuyerSupportRequests>;
  listSellerSupportRequests: (
    params: Parameters<typeof listSellerSupportRequests>[1],
  ) => ReturnType<typeof listSellerSupportRequests>;
  getAccountSupportRequest: (
    supportRequestId: string,
    accountId: string,
  ) => ReturnType<typeof getAccountSupportRequest>;
  getSupportOperationsRequest: (
    supportRequestId: string,
    now?: string,
  ) => ReturnType<typeof getSupportOperationsRequest>;
  projectors: readonly ProjectionHandlerSet[];
}>;

async function getOrderSource(db: PgQueryable, orderId: string): Promise<SupportOrderSource | null> {
  const result = await db.query<SupportOrderSource>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       status,
       total_amount::text AS total_amount,
       (
         SELECT MAX(shipment.delivered_at)::text
         FROM support_shipment_sources AS shipment
         WHERE shipment.order_id = source.order_id
       ) AS delivered_at,
       return_context,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'lineId', line.line_id,
               'amount', line.amount::text,
               'currencyCode', COALESCE(line.currency_code, '')
             ) ORDER BY line.line_id
           )
           FROM support_order_affected_line_amounts AS line
           WHERE line.order_id = source.order_id
         ),
         '[]'::jsonb
       ) AS affected_line_amounts
     FROM support_order_sources AS source
     WHERE source.order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  return row ? { ...row, affected_line_amounts: row.affected_line_amounts ?? [] } : null;
}

function assertParticipantRole(order: SupportOrderSource, accountId: string, role: SupportRequesterRole) {
  if (role === "buyer") {
    if (order.buyer_account_id !== accountId) {
      throw new SupportDomainError("Only the buyer can open this buyer support flow.");
    }
    return;
  }

  if (role === "seller") {
    if (order.seller_account_id !== accountId) {
      throw new SupportDomainError("Only the seller can open this seller support flow.");
    }
    return;
  }

  if (order.buyer_account_id !== accountId && order.seller_account_id !== accountId) {
    throw new SupportDomainError("Support request is not available for this account.");
  }
}

function participantRoleForOrder(order: SupportOrderSource, accountId: string): SupportOrderContext["openedByRole"] {
  if (order.buyer_account_id === accountId) {
    return "buyer";
  }
  if (order.seller_account_id === accountId) {
    return "seller";
  }
  throw new SupportDomainError("Support request is not available for this account.");
}

function supportOrderLines(order: SupportOrderSource): SupportOrderContext["lines"] {
  return order.return_context.flatMap((line) => {
    const amount = order.affected_line_amounts.find((candidate) => candidate.lineId === line.lineId);
    return amount
      ? [
          {
            lineId: line.lineId,
            itemTitle: line.itemTitle,
            productSummary: line.productSummary,
            quantity: line.quantity,
            amount: amount.amount,
            currencyCode: amount.currencyCode,
          },
        ]
      : [];
  });
}

function selectAffectedLineItems(
  order: SupportOrderSource,
  requestedLineIds: readonly string[] | null | undefined,
): readonly SupportAffectedLineItemAmount[] {
  if (requestedLineIds === null || requestedLineIds === undefined) {
    return order.affected_line_amounts;
  }

  if (requestedLineIds.length === 0 || new Set(requestedLineIds).size !== requestedLineIds.length) {
    throw new SupportDomainError("Affected line items must include one or more unique line ids.");
  }

  return requestedLineIds.map((lineId) => {
    const lineItem = order.affected_line_amounts.find((candidate) => candidate.lineId === lineId);
    if (!lineItem) {
      throw new SupportDomainError("Affected line item is not part of the order.");
    }
    return lineItem;
  });
}

async function requireAccountSupportRequest(db: PgQueryable, supportRequestId: string, accountId: string) {
  const supportRequest = await getAccountSupportRequest(db, supportRequestId, accountId);
  if (!supportRequest) {
    throw new SupportDomainError("Support request not found.");
  }
  return supportRequest;
}

async function requireMutableSupportRequest(
  db: PgQueryable,
  params: Readonly<{
    supportRequestId: string;
    accountId: string;
    scope?: SupportRequestMutationScope;
  }>,
) {
  if (params.scope === "operations") {
    const supportRequest = await getSupportOperationsRequest(db, params.supportRequestId);
    if (!supportRequest) {
      throw new SupportDomainError("Support request not found.");
    }
    return supportRequest;
  }

  return requireAccountSupportRequest(db, params.supportRequestId, params.accountId);
}

function isOfferResponseType(responseType: SupportResponseType) {
  return (
    responseType === "accept-return" || responseType === "offer-partial-refund" || responseType === "offer-replacement"
  );
}

export type SupportRequestDeadlineSweepResult = Readonly<{
  autoResolved: number;
  fallbackEscalated: number;
  escalated: number;
  autoClosed: number;
  responseRemindersEmitted: number;
  reviewRemindersEmitted: number;
  returnRefundsReleased: number;
}>;

/**
 * A point `fraction` of the way from `fromIso` to `toIso`. Used to derive
 * reminder thresholds (halfway through the seller-response window, three
 * quarters through the support-review window) from a request's own stamped
 * timestamps rather than a live or catalog-compiled hour count, so reminder
 * timing always matches the deadline actually stamped on this request at
 * open time -- unaffected by later support-deadline policy revisions.
 */
function fractionalPointIso(fromIso: string, toIso: string, fraction: number): string {
  return new Date(Date.parse(fromIso) + (Date.parse(toIso) - Date.parse(fromIso)) * fraction).toISOString();
}

export function accountRoleForSupportRequest(
  supportRequest: Awaited<ReturnType<typeof getAccountSupportRequest>>,
  accountId: string,
): Exclude<SupportRequesterRole, "support"> {
  if (!supportRequest) {
    throw new SupportDomainError("Support request not found.");
  }
  if (supportRequest.buyer_account_id === accountId) {
    return "buyer";
  }
  if (supportRequest.seller_account_id === accountId) {
    return "seller";
  }
  throw new SupportDomainError("Support request is not available for this account.");
}

export function createSupportAttachmentReferenceLifecycle(eventStore: EventStore) {
  const codec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
  const caseStream = (owner: AttachmentOperationOwner) => `support.support-request-${owner.supportRequestId}`;
  async function caseHistory(owner: AttachmentOperationOwner) {
    const history = await readCompleteStream(eventStore, { streamId: caseStream(owner) });
    const evidence = history
      .filter((event) => event.eventType === "support.support-request.evidence-submitted")
      .map((event) => {
        const value = event.payload.evidence;
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new SupportDomainError("attachment_reference_history_unavailable");
        const evidence = value as Record<string, unknown>;
        if (
          !Array.isArray(evidence.attachments) ||
          evidence.attachments.some((reference) => typeof reference !== "string")
        )
          throw new SupportDomainError("attachment_reference_history_unavailable");
        return {
          evidenceId: typeof evidence.evidenceId === "string" ? evidence.evidenceId : undefined,
          attachments: evidence.attachments as string[],
        };
      });
    return { evidence, version: history.at(-1)?.streamVersion ?? 0 };
  }
  async function load(owner: AttachmentOperationOwner, context: EventStoreContext) {
    try {
      validateSupportAttachmentOperationId(owner.operationId);
    } catch {
      throw new SupportDomainError("attachment_reference_unknown");
    }
    const history = await readCompleteStream(eventStore, { streamId: attachmentOperationStreamId(owner) });
    const state = replayAttachmentOperation(history.map(codec.decode));
    if (
      !state.manifest ||
      canonicalJson(state.manifest.owner) !== canonicalJson(owner) ||
      owner.tenantId !== context.tenantId ||
      owner.accountId !== context.audit.forAccountId ||
      history.some((event) => event.tenantId !== owner.tenantId || event.forAccountId !== owner.accountId)
    )
      throw new SupportDomainError("attachment_reference_unknown");
    return { state, version: history.at(-1)?.streamVersion ?? 0 };
  }
  async function atomic(inputs: Parameters<NonNullable<EventStore["appendToStreams"]>>[0]) {
    if (!eventStore.appendToStreams) throw new SupportDomainError("attachment_reference_atomic_append_unavailable");
    return eventStore.appendToStreams(inputs);
  }
  return {
    load,
    claim: async (
      input: AttachmentReferenceClaim &
        Readonly<{ owner: AttachmentOperationOwner; expectedVersion: number; caseVersion: number }>,
      context: EventStoreContext,
    ) => {
      const loaded = await load(input.owner, context);
      if (loaded.version !== input.expectedVersion)
        throw createEventStoreError("concurrency_conflict", "Attachment operation changed.");
      if (canonicalJson(input.attachments) !== canonicalJson(attachmentManifestReferences(loaded.state.manifest!)))
        throw new SupportDomainError("attachment_reference_unknown");
      if (
        !["stored", "reference-claimed", "referenced"].includes(loaded.state.status) ||
        Object.values(loaded.state.attempts).some((attempts) =>
          attempts.some((attempt) => attempt.outcome !== "completed"),
        )
      )
        throw new SupportDomainError("attachment_reference_unknown");
      const data = { evidenceId: input.evidenceId, attachments: input.attachments, submittedAt: input.submittedAt };
      const events = decideAttachmentOperation(loaded.state, { type: "ClaimSupportAttachmentReference", data });
      const results = await atomic([
        {
          streamId: attachmentOperationStreamId(input.owner),
          expectedVersion: input.expectedVersion,
          context,
          events: events.map(codec.encode),
        },
        { streamId: caseStream(input.owner), expectedVersion: input.caseVersion, context, events: [] },
      ]);
      return results[0].storedEvents.at(-1)?.streamVersion ?? loaded.version;
    },
    release: async (
      input: Readonly<{ owner: AttachmentOperationOwner; expectedVersion: number }>,
      context: EventStoreContext,
    ) => {
      const loaded = await load(input.owner, context);
      if (!loaded.state.referenceClaim) throw new SupportDomainError("attachment_reference_unknown");
      const history = await caseHistory(input.owner);
      const references = loaded.state.referenceClaim.attachments;
      if (history.evidence.some((evidence) => evidence.attachments.some((reference) => references.includes(reference))))
        throw new SupportDomainError("attachment_reference_committed");
      const events = decideAttachmentOperation(loaded.state, {
        type: "ReleaseSupportAttachmentReferenceClaim",
        data: { evidenceId: loaded.state.referenceClaim.evidenceId },
      });
      await atomic([
        {
          streamId: attachmentOperationStreamId(input.owner),
          expectedVersion: input.expectedVersion,
          context,
          events: events.map(codec.encode),
        },
        { streamId: caseStream(input.owner), expectedVersion: history.version, context, events: [] },
      ]);
    },
    confirm: async (
      input: Readonly<{ owner: AttachmentOperationOwner; expectedVersion: number }>,
      context: EventStoreContext,
    ) => {
      const loaded = await load(input.owner, context);
      const claim = loaded.state.referenceClaim;
      if (!claim) throw new SupportDomainError("attachment_reference_unknown");
      const history = await caseHistory(input.owner);
      if (
        !history.evidence.some(
          (evidence) =>
            evidence.evidenceId === claim.evidenceId &&
            canonicalJson(evidence.attachments) === canonicalJson(claim.attachments),
        )
      )
        throw new SupportDomainError("attachment_reference_not_committed");
      const events = decideAttachmentOperation(loaded.state, {
        type: "ConfirmSupportAttachmentReferenced",
        data: { evidenceId: claim.evidenceId },
      });
      await atomic([
        {
          streamId: attachmentOperationStreamId(input.owner),
          expectedVersion: input.expectedVersion,
          context,
          events: events.map(codec.encode),
        },
        { streamId: caseStream(input.owner), expectedVersion: history.version, context, events: [] },
      ]);
    },
  };
}

export function createSupportRequestRuntime(deps: SupportRequestRuntimeDeps): SupportRequestServices {
  const resolveFlowDefinitions = async () => {
    if (!deps.policies) return supportFlowCatalog;
    const resolved = await deps.policies.resolvePolicy(supportDeadlinePolicy);
    return supportFlowCatalog.map((flow) => {
      const hours = resolveSupportFlowDeadlineHours(flow.flowType, resolved.value);
      return { ...flow, sellerResponseHours: hours.sellerResponseHours, supportReviewHours: hours.supportReviewHours };
    });
  };
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler: aggregateCommandHandler } = createAggregateCommandHandler<
    SupportRequestState,
    SupportRequestCommand,
    SupportRequestEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SupportRequestEvent>(),
    initialState: () => initialSupportRequestState,
    evolve: evolveSupportRequest,
    decide: decideSupportRequest,
    // Support request streams keep their durable `support.` prefix, but the
    // owning source context for wake routing and read-after-write receipts is
    // Platform Operations.
    commitSourceContextName: "platform-operations",
  });
  const references = createSupportAttachmentReferenceLifecycle(deps.eventStore);
  const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
  const prepareEvidence: PrepareSupportEvidence = async (originalCommand, state, version, context) => {
    const attachments = originalCommand.attachments ?? [];
    const seedContext = isSupportEvidenceSeedContext(context);
    const priorReferences = state.evidence.flatMap((evidence) => evidence.attachments);
    let command = originalCommand;
    let claimVersion: number | undefined;
    let owner: AttachmentOperationOwner | undefined;
    if (attachments.length && command.attachmentOperationId) {
      owner = {
        tenantId: context.tenantId,
        accountId: context.audit.forAccountId,
        supportRequestId: state.supportRequestId!,
        operationId: command.attachmentOperationId,
      };
      const loaded = await references.load(owner, context);
      if (
        command.submittedByAccountId !== owner.accountId ||
        !loaded.state.manifest ||
        canonicalJson(attachments) !== canonicalJson(attachmentManifestReferences(loaded.state.manifest))
      )
        throw new SupportDomainError("attachment_reference_unknown");
      command = {
        ...command,
        evidenceId: deterministicSupportId("sev", command.attachmentOperationId!),
        submittedAt: loaded.state.referenceClaim?.submittedAt ?? command.submittedAt,
      };
      assertSupportEvidenceReferences(attachments, priorReferences, { claimedAttachments: attachments });
      // Decide before claiming: invalid evidence must leave both product streams untouched.
      decideSupportRequest(state, command, { claimedAttachments: attachments });
      claimVersion = await references.claim(
        {
          owner,
          evidenceId: command.evidenceId,
          attachments,
          submittedAt: command.submittedAt,
          expectedVersion: loaded.version,
          caseVersion: version,
        },
        context,
      );
    }
    const authority = {
      seedContext,
      ...(claimVersion === undefined ? {} : { claimedAttachments: attachments }),
    };
    assertSupportEvidenceReferences(attachments, priorReferences, authority);
    return {
      command,
      authority,
      append: async (append) => {
        if (!owner || claimVersion === undefined) return deps.eventStore.appendToStream(append);
        if (!deps.eventStore.appendToStreams)
          throw new SupportDomainError("attachment_reference_atomic_append_unavailable");
        const results = await deps.eventStore.appendToStreams([
          append,
          { streamId: attachmentOperationStreamId(owner), expectedVersion: claimVersion, context, events: [] },
        ]);
        return results[0].storedEvents;
      },
      confirm: async () => {
        if (owner && claimVersion !== undefined)
          await references.confirm({ owner, expectedVersion: claimVersion }, context);
      },
    };
  };
  const commandHandler: SupportRequestServices["commandHandler"] = async (input) => {
    if (input.command.type !== "SubmitSupportEvidence") return aggregateCommandHandler(input);
    const history = await readCompleteStream(deps.eventStore, { streamId: input.streamId });
    const state = history.reduce(
      (current, event) => evolveSupportRequest(current, codec.decode(event)),
      initialSupportRequestState,
    );
    const version = history.at(-1)?.streamVersion ?? 0;
    const fence = await prepareEvidence(input.command, state, version, input.context);
    const newEvents = decideSupportRequest(state, fence.command, fence.authority);
    if (!newEvents.length) {
      await fence.confirm();
      return { state, version, newEvents, storedEvents: [] };
    }
    const append = {
      streamId: input.streamId,
      wakeSourceContextName: "platform-operations",
      expectedVersion: input.expectedVersion ?? version,
      context: input.context,
      events: newEvents.map(codec.encode),
    };
    const storedEvents = await fence.append(append);
    recordCommittedEvents(storedEvents, "platform-operations");
    // Confirmation is a separate command; a retry recovers it from durable case evidence.
    await fence.confirm();
    return {
      state: newEvents.reduce(evolveSupportRequest, state),
      version: storedEvents.at(-1)?.streamVersion ?? version,
      newEvents,
      storedEvents,
    };
  };

  async function resolvePlatformRemedyPolicy(): Promise<{
    value: PlatformRemedyPolicyValue;
    version: string;
  }> {
    if (!deps.policies) {
      return { value: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE, version: `${platformRemedyPolicy.policyKey}:compiled-v1` };
    }
    const resolved = await deps.policies.resolvePolicy(platformRemedyPolicy);
    return { value: resolved.value, version: platformRemedyPolicyVersion(resolved) };
  }

  const evidenceAudit = createEvidenceAccessAudit(deps.eventStore, () => deps.now?.() ?? new Date().toISOString());
  const cleanupCapability = assertSupportEvidenceCleanupCapability(deps.attachmentCleanup);
  const attachmentCleanup: SupportRequestServices["attachmentCleanup"] =
    cleanupCapability.kind === "available"
      ? {
          kind: "available",
          ...createSupportEvidenceCleanupRunner({
            eventStore: deps.eventStore,
            db: deps.db,
            capability: cleanupCapability,
            audit: evidenceAudit,
          }),
        }
      : { kind: "not-mounted" };
  // Record the binding receipt at composition; every run re-awaits it before any provider work.
  if (attachmentCleanup.kind === "available") void attachmentCleanup.initialize().catch(() => undefined);

  async function authorizeEvidenceAccess(
    supportRequestId: string,
    actor: ResolvedActor | null,
    action: EvidenceAccessAction,
  ) {
    if (!/^sup_[A-Za-z0-9_-]{1,80}$/.test(supportRequestId)) throw new EvidenceAccessError(404);
    let state = initialSupportRequestState;
    let authorityUnavailable = false;
    try {
      const events = await readCompleteStream(deps.eventStore, {
        streamId: `support.support-request-${supportRequestId}`,
      });
      const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
      state = events.reduce((current, event) => evolveSupportRequest(current, codec.decode(event)), state);
    } catch {
      authorityUnavailable = true;
    }
    const decision = decideEvidenceAccess(action, actor, state);
    const access =
      authorityUnavailable && decision.status !== 401 && decision.status !== 403
        ? { ...decision, decision: "denied" as const, reason: "authority-unavailable" as const, status: 503 as const }
        : decision;
    try {
      await evidenceAudit.record(supportRequestId, action, actor, access);
    } catch {
      throw new EvidenceAccessError(503);
    }
    if (access.status !== 200) throw new EvidenceAccessError(access.status);
    return state;
  }

  async function evaluatePlatformRemedyProposal(
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      permissions: readonly string[];
      terms: PlatformRemedyTermsInput;
      at: string;
    }>,
  ): Promise<{
    preview: PlatformRemedyProposalPreview;
    policy: PlatformRemedyPolicyValue;
    policyVersion: string;
    authority: NonNullable<ReturnType<typeof strongestRemedyPolicyAuthority>>;
    returnOverrideUsed: boolean;
  }> {
    const supportRequest = await requireMutableSupportRequest(deps.db, {
      supportRequestId: params.supportRequestId,
      accountId: params.accountId,
      scope: "operations",
    });
    if (supportRequest.status !== "resolved" || !supportRequest.resolution?.refundAmount) {
      throw new SupportDomainError("A monetary support decision is required before proposing a remedy.");
    }
    const authority = strongestRemedyPolicyAuthority(params.permissions);
    if (!authority || !params.permissions.includes(platformRemedyCapabilities.propose)) {
      throw new SupportDomainError("The operator cannot propose a platform remedy.");
    }
    const { value: policy, version: policyVersion } = await resolvePlatformRemedyPolicy();
    if (!policy.eligibleReasonCodes.includes(params.terms.reasonCode)) {
      throw new SupportDomainError("The selected reason is not eligible for platform funding.");
    }
    if (params.terms.allocation.fundingKind === "split" && !policy.splitFundingAllowed) {
      throw new SupportDomainError("Split funding is not allowed by the active policy.");
    }
    if (!policy.allowableRefundTriggers.some((trigger) => trigger === params.terms.refundTrigger)) {
      throw new SupportDomainError("The selected refund trigger is not allowed by the active policy.");
    }
    if (compareMoneyAmounts(params.terms.remedy.amount, supportRequest.resolution.refundAmount) !== 0) {
      throw new SupportDomainError("Proposed remedy amount must match the decided refund amount.");
    }
    assertRemedyPolicyLimit({
      authority,
      amount: params.terms.remedy.amount,
      eligibleAmount: supportRequest.resolution.refundAmount,
      policy,
    });
    normalizeRemedyAuthorization(params.supportRequestId as SupportRequestId, {
      type: "AuthorizeSupportRemedy",
      remedyId: "rmd_preview" as RemedyId,
      coverageId: params.terms.allocation.fundingKind === "seller-funded" ? null : ("cov_preview" as CoverageId),
      remedy: params.terms.remedy,
      allocation: params.terms.allocation,
      returnDirective: params.terms.returnDirective,
      refundTrigger: params.terms.refundTrigger,
      policyVersion,
      reasonCode: params.terms.reasonCode,
      idempotencyKey: "preview",
      authorizedAt: params.at,
    });
    const returnOverrideRequired =
      params.terms.returnDirective === "no-return" &&
      compareMoneyAmounts(params.terms.remedy.amount, policy.returnRequiredAtOrAboveAmount) >= 0;
    if (returnOverrideRequired) {
      if (!params.permissions.includes(platformRemedyCapabilities.overrideReturn)) {
        throw new SupportDomainError("This remedy requires return-override authority.");
      }
      if (!policy.returnExceptionReasonCodes.includes(params.terms.returnExceptionReasonCode ?? "")) {
        throw new SupportDomainError("A policy-approved return exception reason is required.");
      }
    }
    const isSplit = params.terms.allocation.fundingKind === "split";
    const requiredApprovalCount =
      compareMoneyAmounts(params.terms.remedy.amount, policy.dualControlAtOrAboveAmount) >= 0 ||
      (isSplit && policy.splitFundingRequiresDualControl)
        ? 2
        : 1;
    const requiresElevatedApproval =
      isSplit || compareMoneyAmounts(params.terms.remedy.amount, policy.maximumAmountByCapability.approve) > 0;
    const reservationExpiresAt =
      params.terms.allocation.fundingKind === "seller-funded"
        ? null
        : new Date(Date.parse(params.at) + policy.reservationExpiryHours * 60 * 60 * 1000).toISOString();
    return {
      policy,
      policyVersion,
      authority,
      returnOverrideUsed: returnOverrideRequired,
      preview: {
        customerOutcome: `${params.terms.remedy.amount} ${params.terms.remedy.currencyCode} ${params.terms.remedy.kind}`,
        sellerImpact: `${params.terms.allocation.sellerFundedAmount} ${params.terms.allocation.currencyCode}`,
        protectionReserveImpact: `${params.terms.allocation.platformFundedAmount} ${params.terms.allocation.currencyCode}`,
        returnLabelCostPayer:
          params.terms.returnDirective === "no-return"
            ? "not-applicable"
            : params.terms.returnDirective === "return-to-platform" ||
                params.terms.allocation.fundingKind !== "seller-funded"
              ? "platform"
              : "seller",
        refundTrigger: String(params.terms.refundTrigger),
        reservationExpiresAt,
        requiredApprovalCount,
        requiresElevatedApproval,
        returnOverrideRequired,
        policyVersion,
      },
    };
  }

  function intakeBinding(
    body: Readonly<{ orderId: string; flowType: string; affectedLineIds: readonly string[] | null }>,
  ) {
    return canonicalParticipantRequest("open-support-request", {
      orderId: body.orderId,
      flowType: body.flowType,
      affectedLineIds: body.affectedLineIds,
    });
  }
  function intakeBindingStream(supportRequestId: string, operationId: string) {
    validateSupportAttachmentOperationId(operationId);
    return `support.participant-intake-${supportRequestId}-${operationId}`;
  }
  async function readIntakeBinding(supportRequestId: string, operationId: string, tenantId: string, accountId: string) {
    const events = await readCompleteStream(deps.eventStore, {
      streamId: intakeBindingStream(supportRequestId, operationId),
    });
    if (
      events.length !== 1 ||
      events[0]!.tenantId !== tenantId ||
      events[0]!.forAccountId !== accountId ||
      events[0]!.eventType !== "support.participant-intake.bound" ||
      typeof events[0]!.payload.binding !== "string"
    )
      throw new SupportDomainError("attachment_reference_unknown");
    return events[0]!.payload.binding;
  }
  const participantRuntime = createParticipantRuntime({
    prepareEvidence,
    eventStore: deps.eventStore,
    now: deps.now,
    authorizeEvidence: (targetId, actor) => authorizeEvidenceAccess(targetId, actor, "submit-participant"),
    prepareOpen: async (body, accountId, supportRequestId, context) => {
      const order = await getOrderSource(deps.db, normalizeOrderId(body.orderId));
      if (!order) throw new SupportDomainError("Order not found for support.");
      const openedByRole = participantRoleForOrder(order, accountId);
      const flowType = normalizeFlowType(body.flowType);
      const flow = getSupportFlowDefinition(flowType);
      if (
        flow.checklist.some(
          (item) => item.required && item.ownerRole === openedByRole && item.evidenceTypes.includes("photo"),
        ) &&
        body.intakePhotoReferences.length === 0
      )
        throw new SupportDomainError(t("support.routes.marketplace.accountSupport.photos.required"));
      if (body.intakePhotoReferences.length) {
        if (
          !body.attachmentOperationId ||
          (await readIntakeBinding(supportRequestId, body.attachmentOperationId, context.tenantId, accountId)) !==
            intakeBinding(body)
        )
          throw new SupportDomainError("attachment_reference_unknown");
      }
      const existing = await findOpenSupportRequestForOrder(deps.db, { orderId: order.order_id });
      if (existing) throw new SupportDomainError("A support case is already open for this order.");
      const affectedLineItems = selectAffectedLineItems(order, body.affectedLineIds);
      const deadlineHours = deps.policies
        ? resolveSupportFlowDeadlineHours(flowType, (await deps.policies.resolvePolicy(supportDeadlinePolicy)).value)
        : null;
      return {
        type: "OpenSupportRequest",
        supportRequestId,
        orderId: order.order_id as OrderId,
        orderTotalAmount: order.total_amount,
        buyerAccountId: order.buyer_account_id as AccountId,
        sellerAccountId: order.seller_account_id as AccountId,
        openedByAccountId: accountId as AccountId,
        openedByRole,
        flowType,
        openedAt: deps.now?.() ?? new Date().toISOString(),
        deliveredAt: order.delivered_at,
        orderReturnContext: order.return_context,
        ...(affectedLineItems.length ? { affectedLineItems } : {}),
        ...(deadlineHours
          ? {
              sellerResponseHours: deadlineHours.sellerResponseHours,
              supportReviewHours: deadlineHours.supportReviewHours,
            }
          : {}),
      };
    },
    isReflected: async (facts) => {
      const first = facts[0];
      const row = await getAccountSupportRequest(deps.db, String(first.payload.supportRequestId), first.forAccountId);
      if (!row) return false;
      return facts.every((fact) => {
        const event = createPassthroughDomainEventCodec<SupportRequestEvent>().decode(fact);
        switch (event.type) {
          case "support.support-request.opened":
            return row.opened_at === event.data.openedAt && row.order_id === event.data.orderId;
          case "support.support-request.evidence-submitted":
            return row.evidence.some((entry) => entry.evidenceId === event.data.evidence.evidenceId);
          case "support.support-request.response-recorded":
            return row.responses.some((entry) => entry.responseId === event.data.response.responseId);
          case "support.support-request.offer-accepted":
            return row.offers.some(
              (entry) => entry.offerId === event.data.offer.offerId && entry.status === "accepted",
            );
          case "support.support-request.offer-declined":
            return row.offers.some(
              (entry) => entry.offerId === event.data.offer.offerId && entry.status === "declined",
            );
          case "support.support-request.escalated":
            return row.escalated_at === event.data.escalatedAt;
          case "support.support-request.cancelled":
            return row.status === "cancelled" && row.cancellation_reason === event.data.reason;
          case "support.support-request.closed":
            return row.closed_at === event.data.closedAt;
          case "support.support-request.resolved":
            return row.resolution?.resolvedAt === event.data.resolution.resolvedAt;
          case "support.support-request.affected-line-items-recorded":
            return true;
          case "support.support-request.return-condition-disputed":
            return row.return_condition_disputed_at === event.data.disputedAt;
          case "platform-operations.csat-outcome-fact.v1":
            return event.data.subject.entityId === row.support_request_id;
          default:
            return false;
        }
      });
    },
  });

  return {
    executeParticipantAttempt: participantRuntime.execute,
    getParticipantAttempt: participantRuntime.lookup,
    commandHandler,
    listFlowDefinitions: async () => {
      return resolveFlowDefinitions();
    },
    resolveSupportFlowDefinition: async (flowType) => {
      const definition = (await resolveFlowDefinitions()).find((flow) => flow.flowType === flowType);
      if (!definition) throw new SupportDomainError("Support flow type is not configured.");
      return definition;
    },
    getSupportOrderContext: async (params) => {
      const orderId = normalizeOrderId(params.orderId);
      const order = await getOrderSource(deps.db, orderId);
      if (!order) {
        throw new SupportDomainError("Order not found for support.");
      }

      const openedByRole = participantRoleForOrder(order, params.accountId);
      const existingOpenRequest = await findOpenSupportRequestForOrder(deps.db, { orderId });

      return {
        orderId: order.order_id,
        openedByRole,
        status: order.status,
        totalAmount: order.total_amount,
        lines: supportOrderLines(order),
        ...(existingOpenRequest
          ? {
              existingOpenRequest: {
                supportRequestId: existingOpenRequest.support_request_id,
                displayReference: existingOpenRequest.display_reference,
                flowType: existingOpenRequest.flow_type,
                status: existingOpenRequest.status,
              },
            }
          : {}),
      };
    },
    openAutomatedSellerCannotFulfillRequest: async (params, context) => {
      const orderId = normalizeOrderId(params.orderId);
      const order = await getOrderSource(deps.db, orderId);
      if (!order) {
        throw new SupportDomainError("Order not found for support.");
      }
      if (order.seller_account_id !== params.sellerAccountId) {
        throw new SupportDomainError("Seller cannot open support for this order.");
      }

      const flowType = normalizeFlowType("seller-cannot-fulfill");
      const deadlineHours = deps.policies
        ? resolveSupportFlowDeadlineHours(flowType, (await deps.policies.resolvePolicy(supportDeadlinePolicy)).value)
        : null;
      const sourceReference = `inventory.reservation.released:${params.reservationRequestId}`;
      const supportRequestId = parseTypedId(deterministicSupportId("sup", sourceReference), "sup");
      const streamId = `support.support-request-${supportRequestId}`;
      const affectedLineItems = selectAffectedLineItems(order, null);

      await commandHandler({
        streamId,
        command: {
          type: "OpenSupportRequest",
          supportRequestId,
          orderId: order.order_id as OrderId,
          orderTotalAmount: order.total_amount,
          buyerAccountId: order.buyer_account_id as AccountId,
          sellerAccountId: order.seller_account_id as AccountId,
          flowType,
          openedByAccountId: params.sellerAccountId as AccountId,
          openedByRole: "seller",
          openedAt: params.releasedAt,
          deliveredAt: order.delivered_at,
          orderReturnContext: order.return_context,
          ...(affectedLineItems.length > 0 ? { affectedLineItems } : {}),
          ...(deadlineHours
            ? {
                sellerResponseHours: deadlineHours.sellerResponseHours,
                supportReviewHours: deadlineHours.supportReviewHours,
              }
            : {}),
        },
        context,
      });

      await commandHandler({
        streamId,
        command: {
          type: "SubmitSupportEvidence",
          evidenceId: deterministicSupportId("sev", sourceReference),
          submittedByAccountId: params.sellerAccountId as AccountId,
          submittedByRole: "seller",
          evidenceType: "seller-attestation",
          summary: `Authorized Honor Offline released inventory reservation ${params.reservationRequestId} (hold ${params.holdId}); the seller cannot fulfill this order.`,
          occurredAt: params.releasedAt,
          submittedAt: params.releasedAt,
          attachments: [],
        },
        context,
      });

      const result = await commandHandler({
        streamId,
        command: {
          type: "ResolveSupportRequest",
          resolutionType: "cancel-order",
          summary:
            "Automatically cancelled because an authorized Honor Offline decision released the order reservation.",
          refundAmount: null,
          responsibility: "seller",
          evidenceBasis: { type: "deterministic-policy", reference: "inventory.honor-offline.v1" },
          responsibilityReasonCode: "seller-cannot-fulfill.seller-unable-to-fulfill",
          resolvedByAccountId: null,
          resolvedByRole: null,
          resolvedAt: params.releasedAt,
        },
        context,
      });

      return { supportRequestId, version: result.version };
    },
    openSupportRequest: async (params, context) => {
      const orderId = normalizeOrderId(params.orderId);
      const order = await getOrderSource(deps.db, orderId);
      if (!order) {
        throw new SupportDomainError("Order not found for support.");
      }

      const flowType = normalizeFlowType(params.flowType);
      const openedByRole = participantRoleForOrder(order, params.accountId);
      getSupportFlowDefinition(flowType);
      assertParticipantRole(order, params.accountId, openedByRole);
      const affectedLineItems = selectAffectedLineItems(order, params.affectedLineIds);

      const existing = await findOpenSupportRequestForOrder(deps.db, { orderId });
      if (existing) {
        throw new SupportDomainError("A support case is already open for this order.");
      }

      // Resolve the support-deadline policy's current value once, here, at
      // open time -- never inside the decider. The resolved hours are
      // stamped onto the command below and, from there, onto the opened
      // event's sellerResponseDueAt/supportReviewDueAt; a later policy
      // revision can never move this request's deadlines (fairness
      // invariant, tested in ../domain/domain.test.ts).
      const deadlineHours = deps.policies
        ? resolveSupportFlowDeadlineHours(flowType, (await deps.policies.resolvePolicy(supportDeadlinePolicy)).value)
        : null;

      const supportRequestId = createId("sup") as SupportRequestId;
      const openedAt = deps.now?.() ?? new Date().toISOString();
      const result = await commandHandler({
        streamId: `support.support-request-${supportRequestId}`,
        command: {
          type: "OpenSupportRequest",
          supportRequestId,
          orderId: order.order_id as OrderId,
          orderTotalAmount: order.total_amount,
          buyerAccountId: order.buyer_account_id as AccountId,
          sellerAccountId: order.seller_account_id as AccountId,
          flowType,
          openedByAccountId: params.accountId as AccountId,
          openedByRole,
          openedAt,
          deliveredAt: order.delivered_at,
          orderReturnContext: order.return_context,
          ...(affectedLineItems.length > 0 ? { affectedLineItems } : {}),
          ...(deadlineHours
            ? {
                sellerResponseHours: deadlineHours.sellerResponseHours,
                supportReviewHours: deadlineHours.supportReviewHours,
              }
            : {}),
        },
        context,
      });

      return { supportRequestId, version: result.version };
    },
    stageParticipantIntakeAttachments: async (params) => {
      const actor = params.actor;
      if (!actor.permissions.includes("support.manage")) throw new EvidenceAccessError(403);
      parseParticipantAttempt({ attemptId: params.attemptId, requestHash: "0".repeat(64) });
      validateSupportAttachmentOperationId(params.operationId);
      const canonical = intakeBinding(params);
      const body = JSON.parse(canonical).payload as {
        orderId: string;
        flowType: SupportFlowType;
        affectedLineIds: readonly string[] | null;
      };
      const order = await getOrderSource(deps.db, normalizeOrderId(body.orderId));
      if (!order || (order.buyer_account_id !== actor.accountId && order.seller_account_id !== actor.accountId))
        throw new EvidenceAccessError(404);
      const role = participantRoleForOrder(order, actor.accountId);
      const flow = getSupportFlowDefinition(body.flowType);
      if (!flow.openedBy.includes(role)) throw new SupportDomainError("attachment_reference_unknown");
      selectAffectedLineItems(order, body.affectedLineIds);
      const supportRequestId = participantOpenSupportRequestId(actor.tenantId, actor.accountId, params.attemptId);
      const context: EventStoreContext = {
        tenantId: actor.tenantId as EventStoreContext["tenantId"],
        audit: {
          performedByUserId: actor.userId as EventStoreContext["audit"]["performedByUserId"],
          forAccountId: actor.accountId as EventStoreContext["audit"]["forAccountId"],
        },
      };
      const streamId = intakeBindingStream(supportRequestId, params.operationId);
      const events = await readCompleteStream(deps.eventStore, { streamId });
      if (!events.length) {
        try {
          await deps.eventStore.appendToStream({
            streamId,
            expectedVersion: "no_stream",
            context,
            events: [{ eventType: "support.participant-intake.bound", payload: { binding: canonical } }],
          });
        } catch (error) {
          if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
        }
      }
      if (
        (await readIntakeBinding(supportRequestId, params.operationId, actor.tenantId, actor.accountId)) !== canonical
      )
        throw new SupportDomainError("attachment_reference_unknown");
      const operationEvents = await readCompleteStream(deps.eventStore, {
        streamId: attachmentOperationStreamId({
          supportRequestId,
          operationId: params.operationId,
        }),
      });
      const operationCodec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
      const operationState = replayAttachmentOperation(operationEvents.map((event) => operationCodec.decode(event)));
      if (hasUnsettledAttachmentPut(operationState))
        throw new SupportEvidenceAttachmentError("Support evidence storage is unavailable.", "storage-unavailable");
      return storeSupportEvidenceAttachments({
        supportRequestId,
        operationId: params.operationId,
        context,
        eventStore: deps.eventStore,
        uploads: await params.uploads(),
        storage: deps.attachmentStorage,
        canonicalizer: deps.attachmentCanonicalizer,
      });
    },
    uploadAttachments: async (params) => {
      await authorizeEvidenceAccess(params.supportRequestId, params.actor, "upload");
      validateSupportAttachmentOperationId(params.operationId);
      const actor = params.actor!;
      return storeSupportEvidenceAttachments({
        supportRequestId: params.supportRequestId,
        operationId: params.operationId,
        eventStore: deps.eventStore,
        context: {
          tenantId: actor.tenantId as EventStoreContext["tenantId"],
          audit: {
            performedByUserId: actor.userId as EventStoreContext["audit"]["performedByUserId"],
            forAccountId: actor.accountId as EventStoreContext["audit"]["forAccountId"],
          },
        },
        uploads: await params.uploads(),
        storage: deps.attachmentStorage,
        canonicalizer: deps.attachmentCanonicalizer,
      });
    },
    getAttachment: async (params) => {
      const supportRequest = await authorizeEvidenceAccess(params.supportRequestId, params.actor, "download");
      const reference = supportRequest.evidence
        .flatMap((evidence) => evidence.attachments)
        .find((candidate) => parseSupportEvidenceAttachmentReference(candidate)?.attachmentId === params.attachmentId);
      if (!reference) {
        return null;
      }
      return readSupportEvidenceAttachment({
        supportRequestId: params.supportRequestId,
        reference,
        storage: deps.attachmentStorage,
      });
    },
    requestAttachmentCleanup: async (params) => {
      await authorizeEvidenceAccess(params.supportRequestId, params.actor, "cleanup-request");
      return requestSupportAttachmentCleanup(deps.eventStore, {
        supportRequestId: params.supportRequestId,
        operationId: params.operationId,
        performedByUserId: params.actor!.userId,
      });
    },
    attachmentCleanup,
    getEvidenceAccessAudit: async (params) => {
      await authorizeEvidenceAccess(params.supportRequestId, params.actor, "audit-read");
      try {
        return await evidenceAudit.page(params.supportRequestId, params.cursor);
      } catch (error) {
        throw error instanceof EvidenceAccessError ? error : new EvidenceAccessError(503);
      }
    },
    submitEvidence: async (params, context) => {
      let evidenceState: SupportRequestState | null = null;
      if (params.attachments?.length) {
        const actor = params.actor ?? null;
        evidenceState = await authorizeEvidenceAccess(
          params.supportRequestId,
          actor,
          params.scope === "operations" ? "submit-operations" : "submit-participant",
        );
        if (
          actor?.accountId !== params.accountId ||
          context?.audit.forAccountId !== actor.accountId ||
          context.audit.performedByUserId !== actor.userId ||
          context.tenantId !== actor.tenantId
        )
          throw new EvidenceAccessError(403);
      }
      if (!context) throw new EvidenceAccessError(401);
      const supportRequest = evidenceState ? null : await requireMutableSupportRequest(deps.db, params);
      const submittedByRole =
        params.scope === "operations"
          ? "support"
          : evidenceState
            ? evidenceState.buyerAccountId === params.accountId
              ? "buyer"
              : "seller"
            : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "SubmitSupportEvidence",
          evidenceId: params.attachmentOperationId
            ? deterministicSupportId("sev", params.attachmentOperationId)
            : createId("sev"),
          submittedByAccountId: params.accountId as AccountId,
          submittedByRole,
          evidenceType: normalizeEvidenceType(params.evidenceType),
          summary: params.summary,
          occurredAt: params.occurredAt ?? null,
          submittedAt: new Date().toISOString(),
          attachments: params.attachments ?? [],
          ...(params.attachmentOperationId ? { attachmentOperationId: params.attachmentOperationId } : {}),
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    recordResponse: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const submittedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const responseType = normalizeResponseType(params.responseType);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RecordSupportResponse",
          responseId: createId("srp"),
          submittedByAccountId: params.accountId as AccountId,
          submittedByRole,
          responseType,
          summary: params.summary,
          submittedAt: new Date().toISOString(),
          offerId: isOfferResponseType(responseType) ? createId("sof") : null,
          offerResolutionType:
            params.offerResolutionType === null || params.offerResolutionType === undefined
              ? null
              : normalizeResolutionType(params.offerResolutionType),
          refundAmount: params.refundAmount ?? null,
          affectedLineIds: params.affectedLineIds ?? null,
          refundCurrencyCode: params.refundCurrencyCode ?? null,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    acceptOffer: async (params, context) => {
      const supportRequest = await requireAccountSupportRequest(deps.db, params.supportRequestId, params.accountId);
      const acceptedByRole = accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "AcceptSupportOffer",
          offerId: params.offerId,
          acceptedByAccountId: params.accountId as AccountId,
          acceptedByRole,
          acceptedAt: new Date().toISOString(),
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    declineOffer: async (params, context) => {
      const supportRequest = await requireAccountSupportRequest(deps.db, params.supportRequestId, params.accountId);
      const declinedByRole = accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "DeclineSupportOffer",
          offerId: params.offerId,
          declinedByAccountId: params.accountId as AccountId,
          declinedByRole,
          declinedAt: new Date().toISOString(),
          summary: params.summary ?? null,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    escalateSupportRequest: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const escalatedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "EscalateSupportRequest",
          escalatedAt: new Date().toISOString(),
          reason: params.reason,
          escalatedByAccountId: params.accountId as AccountId,
          escalatedByRole,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    resolveSupportRequest: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const resolvedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "ResolveSupportRequest",
          resolutionType: normalizeResolutionType(params.resolutionType),
          summary: params.summary,
          refundAmount: params.refundAmount ?? null,
          affectedLineIds: params.affectedLineIds ?? null,
          refundCurrencyCode: params.refundCurrencyCode ?? null,
          responsibility: params.responsibility,
          evidenceBasis: params.evidenceBasis,
          responsibilityReasonCode: params.responsibilityReasonCode,
          resolvedByAccountId: params.accountId as AccountId,
          resolvedByRole,
          resolvedAt: new Date().toISOString(),
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    previewRemedyProposal: async (params) =>
      (
        await evaluatePlatformRemedyProposal({
          ...params,
          at: params.at ?? new Date().toISOString(),
        })
      ).preview,
    proposeRemedy: async (params, context) => {
      const proposedAt = new Date().toISOString();
      const evaluation = await evaluatePlatformRemedyProposal({ ...params, at: proposedAt });
      const remedyId = createId("rmd") as RemedyId;
      const coverageId =
        params.terms.allocation.fundingKind === "seller-funded" ? null : (createId("cov") as CoverageId);
      const terms = normalizeRemedyAuthorization(params.supportRequestId as SupportRequestId, {
        type: "AuthorizeSupportRemedy",
        remedyId,
        coverageId,
        remedy: params.terms.remedy,
        allocation: params.terms.allocation,
        returnDirective: params.terms.returnDirective,
        refundTrigger: params.terms.refundTrigger,
        policyVersion: evaluation.policyVersion,
        reasonCode: params.terms.reasonCode,
        idempotencyKey: params.idempotencyKey,
        authorizedAt: proposedAt,
      });
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "ProposeSupportRemedy",
          terms,
          proposedByAccountId: params.accountId as AccountId,
          permissionUsed: platformRemedyCapabilities.propose,
          rationale: params.rationale,
          evidenceReferences: params.evidenceReferences,
          reservationExpiresAt: evaluation.preview.reservationExpiresAt,
          requiredApprovalCount: evaluation.preview.requiredApprovalCount,
          requiresElevatedApproval: evaluation.preview.requiresElevatedApproval,
          returnOverrideUsed: evaluation.returnOverrideUsed,
          returnExceptionReasonCode: params.terms.returnExceptionReasonCode ?? null,
        },
        context,
      });
      if (!result.state.remedyApproval) {
        throw new SupportDomainError("Remedy proposal did not produce approval state.");
      }
      return {
        supportRequestId: params.supportRequestId,
        remedyId: result.state.remedyApproval.terms.remedyId,
        version: result.version,
        status: result.state.remedyApproval.status,
      };
    },
    approveRemedy: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, {
        supportRequestId: params.supportRequestId,
        accountId: params.accountId,
        scope: "operations",
      });
      const workflow = supportRequest.remedy_approval;
      if (!workflow) throw new SupportDomainError("A remedy must be proposed before approval.");
      const permissionUsed: PlatformRemedyCapability = params.permissions.includes(
        platformRemedyCapabilities.approveElevated,
      )
        ? platformRemedyCapabilities.approveElevated
        : platformRemedyCapabilities.approve;
      if (!params.permissions.includes(permissionUsed)) {
        throw new SupportDomainError("The operator cannot approve this remedy.");
      }
      const policy = (await resolvePlatformRemedyPolicy()).value;
      assertRemedyPolicyLimit({
        authority: permissionUsed === platformRemedyCapabilities.approveElevated ? "approveElevated" : "approve",
        amount: workflow.terms.remedy.amount,
        eligibleAmount: supportRequest.resolution?.refundAmount ?? workflow.terms.remedy.amount,
        policy,
      });
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "ApproveSupportRemedy",
          approvedByAccountId: params.accountId as AccountId,
          permissionUsed,
          reasonCode: params.reasonCode,
          rationale: params.rationale,
          evidenceReferences: params.evidenceReferences,
          idempotencyKey: params.idempotencyKey,
          approvedAt: new Date().toISOString(),
        },
        context,
      });
      const state = result.state.remedyApproval;
      if (!state) throw new SupportDomainError("Remedy approval state is unavailable.");
      return {
        supportRequestId: params.supportRequestId,
        remedyId: state.terms.remedyId,
        version: result.version,
        status: result.state.remedy ? "remedy-in-progress" : state.status,
      };
    },
    retryRemedyEffect: async (params, context) => {
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RetrySupportRemedyEffect",
          remedyId: params.remedyId,
          effect: params.effect,
          requestedByAccountId: params.accountId as AccountId,
          permissionUsed: platformRemedyCapabilities.retry,
          reasonCode: params.reasonCode,
          rationale: params.rationale,
          idempotencyKey: params.idempotencyKey,
          requestedAt: new Date().toISOString(),
        },
        context,
      });
      return { supportRequestId: params.supportRequestId, remedyId: params.remedyId, version: result.version };
    },
    requestRemedyCorrection: async (params, context) => {
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RequestSupportRemedyCorrection",
          requestedByAccountId: params.accountId as AccountId,
          permissionUsed: platformRemedyCapabilities.correct,
          reasonCode: params.reasonCode,
          rationale: params.rationale,
          evidenceReferences: params.evidenceReferences,
          idempotencyKey: params.idempotencyKey,
          requestedAt: new Date().toISOString(),
        },
        context,
      });
      const remedyId = result.state.remedyApproval?.terms.remedyId;
      if (!remedyId) throw new SupportDomainError("Remedy correction state is unavailable.");
      return { supportRequestId: params.supportRequestId, remedyId, version: result.version };
    },
    recordRemedyEffect: async (params, context) => {
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RecordSupportRemedyEffect",
          remedyId: params.remedyId,
          coverageId: params.coverageId ?? null,
          effect: params.effect,
          outcome: params.outcome,
          sourceFactType: params.sourceFactType,
          sourceFactId: params.sourceFactId,
          idempotencyKey: params.idempotencyKey,
          occurredAt: params.occurredAt,
          reasonCode: params.reasonCode,
          refundId: params.refundId ?? null,
          amount: params.amount ?? null,
          currencyCode: params.currencyCode ?? null,
          allocation: params.allocation ?? null,
        },
        context,
      });
      return { supportRequestId: params.supportRequestId, remedyId: params.remedyId, version: result.version };
    },
    overrideRemedyEffect: async (params, context) => {
      await requireMutableSupportRequest(deps.db, {
        supportRequestId: params.supportRequestId,
        accountId: params.accountId,
        scope: "operations",
      });
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "OverrideSupportRemedyEffect",
          remedyId: params.remedyId,
          effect: params.effect,
          actorAccountId: params.accountId as AccountId,
          permissionUsed: platformRemedyCapabilities.waive,
          reasonCode: params.reasonCode,
          rationale: params.rationale,
          evidenceReferences: params.evidenceReferences,
          idempotencyKey: params.idempotencyKey,
          overriddenAt: new Date().toISOString(),
        },
        context,
      });
      return { supportRequestId: params.supportRequestId, remedyId: params.remedyId, version: result.version };
    },
    closeSupportRequest: async (params, context) => {
      await requireMutableSupportRequest(deps.db, params);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "CloseSupportRequest",
          closedAt: new Date().toISOString(),
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    cancelSupportRequest: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      if (params.scope !== "operations" && supportRequest.opened_by_account_id !== params.accountId) {
        throw new SupportDomainError("Only the account that opened this support request can cancel it.");
      }
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "CancelSupportRequest",
          cancelledAt: new Date().toISOString(),
          reason: params.reason,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    recordReturnDelivery: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const recordedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RecordReturnDelivery",
          deliveredAt: params.deliveredAt ?? new Date().toISOString(),
          recordedByAccountId: params.accountId as AccountId,
          recordedByRole,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    disputeReturnCondition: async (params, context) => {
      const supportRequest = await requireAccountSupportRequest(deps.db, params.supportRequestId, params.accountId);
      const disputedByRole = accountRoleForSupportRequest(supportRequest, params.accountId);
      if (disputedByRole !== "seller") {
        throw new SupportDomainError("Only the seller can dispute the returned item's condition.");
      }
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "DisputeReturnCondition",
          disputedAt: new Date().toISOString(),
          reason: params.reason,
          disputedByAccountId: params.accountId as AccountId,
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    releaseReturnRefund: async (params, context) => {
      await requireMutableSupportRequest(deps.db, {
        supportRequestId: params.supportRequestId,
        accountId: params.accountId,
        scope: "operations",
      });
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "ReleaseReturnRefund",
          releasedAt: new Date().toISOString(),
          releasedByAccountId: params.accountId as AccountId,
          releasedByRole: "support",
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
    },
    listSupportRequestsAwaitingReturnDelivery: (params) => listSupportRequestsAwaitingReturnDelivery(deps.db, params),
    escalateOverdueSupportRequests: async (params, context) => {
      const now = params.now ?? new Date().toISOString();
      const limit = params.limit ?? 100;
      const queue = await listSupportOperationsQueue(deps.db, {
        now,
        limit,
      });
      // The sweep only evaluates the fetched page: if the active queue holds
      // more candidates than the page limit, some overdue cases outside this
      // window were not examined this run and the caller needs to know the
      // pass was partial rather than exhaustive.
      const capped = queue.total > queue.items.length;
      let escalated = 0;
      let skipped = 0;

      for (const supportRequest of queue.items) {
        const deadlineReached =
          (supportRequest.seller_response_due_at !== null &&
            Date.parse(supportRequest.seller_response_due_at) <= Date.parse(now)) ||
          (supportRequest.support_review_due_at !== null &&
            Date.parse(supportRequest.support_review_due_at) <= Date.parse(now));
        if (supportRequest.status === "ready-for-support" || !deadlineReached) {
          skipped += 1;
          continue;
        }

        const result = await commandHandler({
          streamId: `support.support-request-${supportRequest.support_request_id}`,
          command: {
            type: "EscalateSupportRequest",
            escalatedAt: now,
            reason: "Support deadline reached.",
          },
          context,
        });
        if (result.newEvents.length > 0) {
          escalated += 1;
        } else {
          skipped += 1;
        }
      }

      return { escalated, skipped, capped, total: queue.total };
    },
    sweepSupportRequestDeadlines: async (params, context) => {
      const now = params.now ?? new Date().toISOString();
      const limit = params.limit ?? 100;
      let autoResolved = 0;
      let fallbackEscalated = 0;
      let escalated = 0;
      let autoClosed = 0;
      let responseRemindersEmitted = 0;
      let reviewRemindersEmitted = 0;
      let returnRefundsReleased = 0;

      // 1. Seller-silence candidates: auto-resolve to the flow default when
      // that default needs no human-computed value; otherwise (or if the
      // resolve attempt fails domain validation, e.g. incomplete return
      // evidence) escalate instead of leaving the case stuck past its
      // deadline. The whole per-candidate attempt is isolated: the read-model
      // snapshot can be stale by the time the command reaches the aggregate
      // (a concurrent sweep pass, a manual admin action, or a party response
      // may have already moved the case), and every command re-validates
      // against live state, so a losing attempt here is expected, not an
      // error — the next sweep pass re-evaluates from fresh state.
      const silenceCandidates = await listSupportRequestsPastSellerResponseDeadline(deps.db, { now, limit });
      for (const candidate of silenceCandidates) {
        const streamId = `support.support-request-${candidate.support_request_id}`;
        const definition = getSupportFlowDefinition(normalizeFlowType(candidate.flow_type));

        try {
          if (definition.autoResolvesOnSellerSilence) {
            // The window named in the message is the hours actually stamped
            // on this request at open time (from `candidate.opened_at` to
            // `candidate.seller_response_due_at`), not the flow's live or
            // catalog-compiled default -- those can diverge once a support
            // deadline policy revision has landed.
            const windowHours =
              candidate.seller_response_due_at != null
                ? Math.round(
                    (Date.parse(candidate.seller_response_due_at) - Date.parse(candidate.opened_at)) / (60 * 60 * 1000),
                  )
                : definition.sellerResponseHours;
            const result = await commandHandler({
              streamId,
              command: {
                type: "ResolveSupportRequest",
                resolutionType: definition.defaultResolution,
                summary: `Automatically resolved: the seller did not respond within the ${windowHours}-hour support window.`,
                refundAmount: null,
                resolvedByAccountId: null,
                resolvedByRole: null,
                resolvedAt: now,
                ...(definition.automatedResolutionResponsibility ??
                  sellerSilenceResponsibilityFact(definition.flowType)),
              },
              context,
            });
            if (result.newEvents.length > 0) {
              autoResolved += 1;
            }
            // Zero new events means the case is already resolved (idempotent
            // no-op, e.g. a concurrent runner won the race); nothing further
            // to do for this candidate.
            continue;
          }

          const escalateResult = await commandHandler({
            streamId,
            command: {
              type: "EscalateSupportRequest",
              escalatedAt: now,
              reason: "Support deadline reached; this flow requires support to determine the remedy.",
            },
            context,
          });
          if (escalateResult.newEvents.length > 0) {
            fallbackEscalated += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          if (!definition.autoResolvesOnSellerSilence) {
            // Escalation itself was rejected (case already moved on); skip.
            continue;
          }
          // The default resolution could not be safely applied (for example
          // incomplete return evidence); fall back to escalating instead.
          try {
            const escalateResult = await commandHandler({
              streamId,
              command: {
                type: "EscalateSupportRequest",
                escalatedAt: now,
                reason: "Support deadline reached; the default resolution could not be safely applied automatically.",
              },
              context,
            });
            if (escalateResult.newEvents.length > 0) {
              fallbackEscalated += 1;
            }
          } catch (escalateError) {
            if (!(escalateError instanceof SupportDomainError)) {
              throw escalateError;
            }
            // Case moved on between the resolve attempt and this fallback
            // (e.g. a concurrent runner or manual action already handled it).
          }
        }
      }

      // 2. Halfway-elapsed reminders for the party currently expected to act
      // (the seller, while waiting on their response).
      const responseReminderCandidates = await listSupportRequestsNeedingResponseReminder(deps.db, { now, limit });
      for (const candidate of responseReminderCandidates) {
        if (candidate.seller_response_due_at == null) {
          continue;
        }
        const halfwayAt = fractionalPointIso(candidate.opened_at, candidate.seller_response_due_at, 0.5);
        if (Date.parse(halfwayAt) > Date.parse(now)) {
          continue;
        }
        try {
          const result = await commandHandler({
            streamId: `support.support-request-${candidate.support_request_id}`,
            command: { type: "EmitSupportResponseReminder", remindedAt: now },
            context,
          });
          if (result.newEvents.length > 0) {
            responseRemindersEmitted += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          // The case moved on (resolved, responded, or already reminded by a
          // concurrent runner) between the read-model query and this command.
        }
      }

      // 3. Support-review-approaching reminders for ready-for-support cases
      // (last quarter of the review window).
      const reviewReminderCandidates = await listSupportRequestsNeedingReviewReminder(deps.db, { now, limit });
      for (const candidate of reviewReminderCandidates) {
        const approachingAt = fractionalPointIso(candidate.opened_at, candidate.support_review_due_at, 0.75);
        if (Date.parse(approachingAt) > Date.parse(now)) {
          continue;
        }
        try {
          const result = await commandHandler({
            streamId: `support.support-request-${candidate.support_request_id}`,
            command: { type: "EmitSupportReviewReminder", remindedAt: now },
            context,
          });
          if (result.newEvents.length > 0) {
            reviewRemindersEmitted += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          // The case moved on (resolved or already reminded by a concurrent
          // runner) between the read-model query and this command.
        }
      }

      // 4. Contested/overdue cases outside the silence path (post-challenge,
      // post-declined-offer, or otherwise stale) escalate on deadline expiry
      // rather than auto-resolving.
      const escalationCandidates = await listSupportRequestsOverdueForEscalation(deps.db, { now, limit });
      for (const candidate of escalationCandidates) {
        try {
          const result = await commandHandler({
            streamId: `support.support-request-${candidate.support_request_id}`,
            command: { type: "EscalateSupportRequest", escalatedAt: now, reason: "Support deadline reached." },
            context,
          });
          if (result.newEvents.length > 0) {
            escalated += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          // The case moved on (resolved/closed/cancelled) between the
          // read-model query and this command.
        }
      }

      // 5. Resolved cases past their 7-day auto-close clock release
      // settlement holds and leave the operations queue.
      const closeCandidates = await listSupportRequestsReadyForAutoClose(deps.db, { now, limit });
      for (const candidate of closeCandidates) {
        try {
          const result = await commandHandler({
            streamId: `support.support-request-${candidate.support_request_id}`,
            command: { type: "CloseSupportRequest", closedAt: now },
            context,
          });
          if (result.newEvents.length > 0) {
            autoClosed += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          // Already closed by a concurrent runner; idempotent no-op.
        }
      }

      // 6. Return-for-refund cases whose returned item was delivered back
      // and whose 5-day inspection window has elapsed release automatically
      // (system actor, `releasedByRole: null`), letting the payments
      // support-refund-effect projection actually issue the refund. A case
      // the seller disputed within the window is excluded by the query
      // itself (its gate has already moved to `return-condition-disputed`),
      // so it never reaches this step.
      const returnRefundCandidates = await listSupportRequestsReadyForReturnRefundRelease(deps.db, { now, limit });
      for (const candidate of returnRefundCandidates) {
        try {
          const result = await commandHandler({
            streamId: `support.support-request-${candidate.support_request_id}`,
            command: {
              type: "ReleaseReturnRefund",
              releasedAt: now,
              releasedByAccountId: null,
              releasedByRole: null,
            },
            context,
          });
          if (result.newEvents.length > 0) {
            returnRefundsReleased += 1;
          }
        } catch (error) {
          if (!(error instanceof SupportDomainError)) {
            throw error;
          }
          // The case moved on (seller disputed, or a concurrent runner
          // already released it) between the read-model query and this
          // command.
        }
      }

      return {
        autoResolved,
        fallbackEscalated,
        escalated,
        autoClosed,
        responseRemindersEmitted,
        reviewRemindersEmitted,
        returnRefundsReleased,
      };
    },
    listSupportOperationsQueue: (params) => listSupportOperationsQueue(deps.db, params),
    listBuyerSupportRequests: (params) => listBuyerSupportRequests(deps.db, params),
    listSellerSupportRequests: (params) => listSellerSupportRequests(deps.db, params),
    getAccountSupportRequest: (supportRequestId, accountId) =>
      getAccountSupportRequest(deps.db, supportRequestId, accountId),
    getSupportOperationsRequest: (supportRequestId, now) => getSupportOperationsRequest(deps.db, supportRequestId, now),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "support-request-projection",
        handlers: buildSupportRequestProjectionHandlers(deps.db),
        // Support events keep their durable support. stream prefix, so the
        // platform-operations default (`platform-operations.`) must not apply.
        streamPrefixes: ["support."],
      }),
      createProjectionHandlerSet({
        ...supportEvidenceCleanupLocatorProjection,
        handlers: buildSupportEvidenceCleanupLocatorHandlers(deps.db, deps.eventStore),
      }),
      createProjectionHandlerSet({
        projectionName: SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildSupportRequestTransactionalEmailProjectionHandlers(
          deps.db,
          notificationOutbox,
          SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
        streamPrefixes: ["support."],
      }),
    ],
  };
}

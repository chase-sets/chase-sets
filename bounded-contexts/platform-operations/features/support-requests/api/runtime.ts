import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
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
  storeSupportEvidenceAttachments,
  type StoredSupportEvidenceAttachment,
  type SupportEvidenceAttachmentSecurityScanner,
  type SupportEvidenceAttachmentStorage,
  type SupportEvidenceAttachmentUpload,
} from "./attachments";
import { parseSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
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
  attachmentSecurityScanner?: SupportEvidenceAttachmentSecurityScanner;
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

export type SupportRequestServices = Readonly<{
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
  openSupportRequest: (
    params: Readonly<{
      orderId: string;
      accountId: string;
      flowType: SupportFlowType | string;
      affectedLineIds?: readonly string[] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  getSupportOrderContext: (params: Readonly<{ orderId: string; accountId: string }>) => Promise<SupportOrderContext>;
  uploadAttachments: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      roleKey: string;
      uploads: readonly SupportEvidenceAttachmentUpload[];
    }>,
  ) => Promise<readonly StoredSupportEvidenceAttachment[] | null>;
  getAttachment: (
    params: Readonly<{
      supportRequestId: string;
      attachmentId: string;
      accountId: string;
      roleKey: string;
    }>,
  ) => Promise<Readonly<{ body: Uint8Array; contentType: string }> | null>;
  submitEvidence: (
    params: Readonly<{
      supportRequestId: string;
      accountId: string;
      submittedByRole: SupportRequesterRole | string;
      evidenceType: SupportEvidenceType | string;
      summary: string;
      occurredAt?: string | null;
      attachments?: readonly string[];
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
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
  getSupportOperationsRequest: (supportRequestId: string) => ReturnType<typeof getSupportOperationsRequest>;
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

function accountRoleForSupportRequest(
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

export function createSupportRequestRuntime(deps: SupportRequestRuntimeDeps): SupportRequestServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler } = createAggregateCommandHandler({
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

  async function getAttachmentCase(params: Readonly<{ supportRequestId: string; accountId: string; roleKey: string }>) {
    return params.roleKey === "platform-admin"
      ? getSupportOperationsRequest(deps.db, params.supportRequestId)
      : getAccountSupportRequest(deps.db, params.supportRequestId, params.accountId);
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

  return {
    commandHandler,
    listFlowDefinitions: async () => {
      if (!deps.policies) {
        return supportFlowCatalog;
      }
      const resolved = await deps.policies.resolvePolicy(supportDeadlinePolicy);
      return supportFlowCatalog.map((flow) => {
        const hours = resolveSupportFlowDeadlineHours(flow.flowType, resolved.value);
        return {
          ...flow,
          sellerResponseHours: hours.sellerResponseHours,
          supportReviewHours: hours.supportReviewHours,
        };
      });
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
    uploadAttachments: async (params) => {
      const supportRequest = await getAttachmentCase(params);
      if (!supportRequest) {
        return null;
      }
      return storeSupportEvidenceAttachments({
        supportRequestId: params.supportRequestId,
        uploads: params.uploads,
        storage: deps.attachmentStorage,
        securityScanner: deps.attachmentSecurityScanner,
      });
    },
    getAttachment: async (params) => {
      const supportRequest = await getAttachmentCase(params);
      if (!supportRequest) {
        return null;
      }
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
    submitEvidence: async (params, context) => {
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const submittedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "SubmitSupportEvidence",
          evidenceId: createId("sev"),
          submittedByAccountId: params.accountId as AccountId,
          submittedByRole,
          evidenceType: normalizeEvidenceType(params.evidenceType),
          summary: params.summary,
          occurredAt: params.occurredAt ?? null,
          submittedAt: new Date().toISOString(),
          attachments: params.attachments ?? [],
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
    getSupportOperationsRequest: (supportRequestId) => getSupportOperationsRequest(deps.db, supportRequestId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "support-request-projection",
        handlers: buildSupportRequestProjectionHandlers(deps.db),
        // Support events keep their durable support. stream prefix, so the
        // platform-operations default (`platform-operations.`) must not apply.
        streamPrefixes: ["support."],
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

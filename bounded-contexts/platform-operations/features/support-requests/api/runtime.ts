import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeEvidenceType,
  normalizeFlowType,
  normalizeRequesterRole,
  normalizeResolutionType,
  normalizeResponseType,
  normalizeRequiredText,
  SupportDomainError,
  type SupportEvidenceType,
  type SupportFlowType,
  type SupportOrderReturnContextLine,
  type SupportRequesterRole,
  type SupportResolutionType,
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
import { getSupportFlowDefinition, supportFlowCatalog } from "../domain/flow-catalog";
import {
  buildSupportRequestTransactionalEmailProjectionHandlers,
  SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import { buildSupportRequestProjectionHandlers } from "../read-model/projection";
import {
  findOpenSupportRequestForOrderAndFlow,
  getAccountSupportRequest,
  getSupportOperationsRequest,
  listSupportOperationsQueue,
  listBuyerSupportRequests,
  listSellerSupportRequests,
} from "../read-model/queries";

type SupportRequestRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationOutbox?: NotificationOutbox;
}>;

type SupportRequestMutationScope = "participant" | "operations";

export type SupportOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
  total_amount: string;
  return_context: readonly SupportOrderReturnContextLine[];
}>;

export type SupportOrderContext = Readonly<{
  orderId: string;
  openedByRole: "buyer" | "seller";
  status: string;
  totalAmount: string;
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
  listFlowDefinitions: () => typeof supportFlowCatalog;
  openSupportRequest: (
    params: Readonly<{
      orderId: string;
      accountId: string;
      flowType: SupportFlowType | string;
      openedByRole: SupportRequesterRole | string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
  getSupportOrderContext: (
    params: Readonly<{ orderId: string; accountId: string; openedByRole?: string | null }>,
  ) => Promise<SupportOrderContext>;
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
      scope?: SupportRequestMutationScope;
    }>,
    context: EventStoreContext,
  ) => Promise<{ supportRequestId: string; version: number }>;
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
  ) => Promise<{ escalated: number; skipped: number }>;
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
       return_context
     FROM support_order_sources
     WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0] ?? null;
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

function normalizeParticipantLookupRole(value: string): SupportOrderContext["openedByRole"] {
  const role = normalizeRequesterRole(value);
  if (role === "support") {
    throw new SupportDomainError("Support order lookup must be opened as buyer or seller.");
  }
  return role;
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
  });

  return {
    commandHandler,
    listFlowDefinitions: () => supportFlowCatalog,
    getSupportOrderContext: async (params) => {
      const orderId = normalizeOrderId(params.orderId);
      const order = await getOrderSource(deps.db, orderId);
      if (!order) {
        throw new SupportDomainError("Order not found for support.");
      }

      const openedByRole =
        typeof params.openedByRole === "string" && params.openedByRole.trim()
          ? normalizeParticipantLookupRole(params.openedByRole)
          : order.buyer_account_id === params.accountId
            ? "buyer"
            : "seller";
      assertParticipantRole(order, params.accountId, openedByRole);

      return {
        orderId: order.order_id,
        openedByRole,
        status: order.status,
        totalAmount: order.total_amount,
      };
    },
    openSupportRequest: async (params, context) => {
      const orderId = normalizeOrderId(params.orderId);
      const order = await getOrderSource(deps.db, orderId);
      if (!order) {
        throw new SupportDomainError("Order not found for support.");
      }

      const flowType = normalizeFlowType(params.flowType);
      const openedByRole = normalizeRequesterRole(params.openedByRole);
      getSupportFlowDefinition(flowType);
      assertParticipantRole(order, params.accountId, openedByRole);

      const existing = await findOpenSupportRequestForOrderAndFlow(deps.db, {
        orderId,
        flowType,
      });
      if (existing) {
        throw new SupportDomainError("An open support request already exists for this order and issue.");
      }

      const supportRequestId = createId("sup") as SupportRequestId;
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
          openedAt: new Date().toISOString(),
          orderReturnContext: order.return_context,
        },
        context,
      });

      return { supportRequestId, version: result.version };
    },
    submitEvidence: async (params, context) => {
      await requireMutableSupportRequest(deps.db, params);
      const supportRequest = await requireMutableSupportRequest(deps.db, params);
      const resolvedByRole =
        params.scope === "operations" ? "support" : accountRoleForSupportRequest(supportRequest, params.accountId);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "SubmitSupportEvidence",
          evidenceId: createId("sev"),
          submittedByAccountId: params.accountId as AccountId,
          submittedByRole: normalizeRequesterRole(params.submittedByRole),
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
      await requireMutableSupportRequest(deps.db, params);
      const responseType = normalizeResponseType(params.responseType);
      const result = await commandHandler({
        streamId: `support.support-request-${params.supportRequestId}`,
        command: {
          type: "RecordSupportResponse",
          responseId: createId("srp"),
          submittedByAccountId: params.accountId as AccountId,
          submittedByRole: normalizeRequesterRole(params.submittedByRole),
          responseType,
          summary: params.summary,
          submittedAt: new Date().toISOString(),
          offerId: isOfferResponseType(responseType) ? createId("sof") : null,
          offerResolutionType:
            params.offerResolutionType === null || params.offerResolutionType === undefined
              ? null
              : normalizeResolutionType(params.offerResolutionType),
          refundAmount: params.refundAmount ?? null,
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
          resolvedByAccountId: params.accountId as AccountId,
          resolvedByRole,
          resolvedAt: new Date().toISOString(),
        },
        context,
      });

      return { supportRequestId: params.supportRequestId, version: result.version };
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
      await requireMutableSupportRequest(deps.db, params);
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
    escalateOverdueSupportRequests: async (params, context) => {
      const now = params.now ?? new Date().toISOString();
      const queue = await listSupportOperationsQueue(deps.db, {
        now,
        limit: params.limit ?? 100,
      });
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

      return { escalated, skipped };
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

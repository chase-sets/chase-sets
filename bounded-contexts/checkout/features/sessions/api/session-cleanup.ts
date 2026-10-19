import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import { CheckoutDomainError, type CartLineId } from "../../../support/runtime-support/common";
import {
  retainedOrderCartCleanup,
  type CheckoutSessionCommand,
  type CheckoutSessionEvent,
  type CheckoutSessionState,
} from "../domain/domain";
import type { CheckoutSessionMutationResult, CheckoutSessionServices } from "./runtime";
import { commitMetadataFromStoredEvents } from "./session-entry";
import {
  assertBuyerDeliveryAddressServiceable,
  assertCheckoutHandoffNotExpired,
  assertCurrentCartReadinessForUncommittedSession,
  assertOrderableSessionFulfillmentAssigned,
  assertSessionNotCancelled,
} from "./session-read";

export class OrderCartCleanupError extends CheckoutDomainError {
  constructor(readonly commitMetadata: Omit<CheckoutSessionMutationResult, "sessionId" | "session"> = {}) {
    super("Cart cleanup could not finish. Retry checkout.");
  }
}

type CleanupRepository = Readonly<{ load: (streamId: string) => Promise<{ state: CheckoutSessionState }> }>;

export type CheckoutSessionCleanupDeps = Readonly<{
  eventStore: EventStore;
  cart: CheckoutCartServices;
  repository: CleanupRepository;
  loadSessionStateForBuyer: (sessionId: string, accountId: AccountId) => Promise<CheckoutSessionState>;
  applySessionCommandForBuyer: (
    params: Readonly<{ sessionId: string; accountId: AccountId; command: CheckoutSessionCommand }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  stateToCheckoutSessionRow: (state: CheckoutSessionState) => CheckoutSessionMutationResult["session"];
}>;

export async function readCleanupCommitMetadata(
  eventStore: EventStore,
  sessionId: string,
  state: CheckoutSessionState,
) {
  const events = await readCompleteStream(eventStore, { streamId: `checkout.session-${sessionId}` });
  const metadata = commitMetadataFromStoredEvents(events);
  return { ...metadata, commitPositions: [...metadata.commitPositions, ...state.orderWriteCommitPositions] };
}

export function createCheckoutSessionCleanupService(
  deps: CheckoutSessionCleanupDeps,
): Pick<CheckoutSessionServices, "resumeOrderCartCleanup" | "recordOrdersCreated"> {
  function assertCleanupContext(accountId: AccountId, context: EventStoreContext) {
    if (!context?.tenantId || !context.audit?.performedByUserId || context.audit.forAccountId !== accountId)
      throw new CheckoutDomainError("Checkout buyer context is required.");
  }
  async function cleanupCommitMetadata(sessionId: string, state: CheckoutSessionState) {
    return readCleanupCommitMetadata(deps.eventStore, sessionId, state);
  }
  const resumeOrderCartCleanup: CheckoutSessionServices["resumeOrderCartCleanup"] = async (params, context) => {
    assertCleanupContext(params.accountId, context);
    let metadata: OrderCartCleanupError["commitMetadata"] = {};
    try {
      const state = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
      const cleanup = retainedOrderCartCleanup(state);
      metadata = await cleanupCommitMetadata(params.sessionId, state);
      if (!cleanup || cleanup.status === "complete")
        return { sessionId: params.sessionId, session: deps.stateToCheckoutSessionRow(state), ...metadata };
      const claimedOwnerKeys = new Set(await deps.cart.listClaimedOwnerKeys(cleanup.plan.buyerAccountId));
      for (const ownerKey of cleanup.plan.sourceOwnerKeys) {
        if (claimedOwnerKeys.has(ownerKey)) continue;
        for (const lineId of cleanup.plan.lineIds) {
          try {
            await deps.cart.removeLine({ accountId: ownerKey as AccountId, lineId: lineId as CartLineId }, context);
          } catch (error) {
            if (!(error instanceof CheckoutDomainError && error.message === "Cart line not found.")) throw error;
          }
        }
      }
      const completed = await deps.applySessionCommandForBuyer(
        { ...params, command: { type: "CompleteOrderCartCleanup", completedAt: new Date().toISOString() } },
        context,
      );
      const current = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
      return { ...completed, ...(await cleanupCommitMetadata(params.sessionId, current)) };
    } catch {
      try {
        const current = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
        metadata = await cleanupCommitMetadata(params.sessionId, current);
      } catch {
        /* Preserve the last known committed metadata while the store remains unavailable. */
      }
      throw new OrderCartCleanupError(metadata);
    }
  };
  const recordOrdersCreated: CheckoutSessionServices["recordOrdersCreated"] = async (params, context) => {
    assertCleanupContext(params.accountId, context);
    const state = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
    if (state.orderIds.length > 0) return resumeOrderCartCleanup(params, context);
    assertSessionNotCancelled(state);
    assertCheckoutHandoffNotExpired(state);
    await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
    assertOrderableSessionFulfillmentAssigned(state);
    assertBuyerDeliveryAddressServiceable(state.shippingAddress);
    let result: CheckoutSessionMutationResult;
    try {
      result = await deps.applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "RecordOrdersCreated",
            orderIds: params.orderIds as OrderId[],
            fulfilledLineKeys: params.fulfilledLineKeys,
            orderWriteCommitPositions: params.orderWriteCommitPositions,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    } catch {
      let metadata: OrderCartCleanupError["commitMetadata"] = {};
      try {
        const current = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
        metadata = await readCleanupCommitMetadata(deps.eventStore, params.sessionId, current);
      } catch {
        /* Retry reloads durable intent when the store is unavailable. */
      }
      throw new OrderCartCleanupError(metadata);
    }
    if (
      result.session.source_type === "cart" &&
      !result.session.lines.some((line) => line.cartLineId) &&
      (params.fulfilledLineKeys?.length ?? 0) === 0 &&
      result.commitEventIds?.length
    ) {
      await deps.cart.checkout(state.buyerAccountId!, context);
      return result;
    }
    return resumeOrderCartCleanup(params, context);
  };
  return { resumeOrderCartCleanup, recordOrdersCreated };
}

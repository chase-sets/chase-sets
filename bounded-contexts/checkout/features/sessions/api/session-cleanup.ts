import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CheckoutCartLineCommandInput } from "../../command-attempts/api/cart-attempt";
import { computeCheckoutCommandAttemptRequestHash } from "../../command-attempts/api/contracts";
import { checkoutOrderCartCleanupAttemptId } from "../../command-attempts/api/attempt-history";
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

/** Safe at HTTP/UCP boundaries: never retain a key-bearing lower-layer cause. */
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
  async function applyOrderCartCleanupAttempt(
    sessionId: string,
    ownerKey: string,
    target: CartLineId | "checkout",
    context: EventStoreContext,
  ) {
    const commands: CheckoutCartLineCommandInput[] =
      target === "checkout" ? [{ type: "checkout" }] : [{ type: "remove", lineId: target }];
    const { result } = await deps.cart.executeCartAttempt(
      {
        ownerKey,
        attemptId: checkoutOrderCartCleanupAttemptId(sessionId, ownerKey, target),
        kind: "cart.session-cleanup",
        target,
        requestHash: await computeCheckoutCommandAttemptRequestHash({ commands }),
        commands,
      },
      context,
    );
    const line = result.ownerStatus === "committed" ? result.vector![0] : undefined;
    if (!line || line.outcome !== "succeeded")
      throw new CheckoutDomainError(line?.message ?? "Order cart cleanup could not be confirmed.");
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
      // The retained plan is unchanged: the same durable Account and anonymous
      // sources, the same line ids, one lifecycle. What the sweep adds is reach.
      // Removing as the buyer Account is already line-id-total across every key
      // that Account has claimed, so a retained source it now owns is covered by
      // that pass -- and must be dropped from this loop, because acting as a
      // claimed anonymous key is exactly what the claimed stream refuses.
      // A source claimed by some other Account stays in the loop and its
      // refusal propagates, rather than being skipped as if it were clean.
      const claimedOwnerKeys = new Set(await deps.cart.listClaimedOwnerKeys(cleanup.plan.buyerAccountId));
      for (const ownerKey of cleanup.plan.sourceOwnerKeys) {
        if (claimedOwnerKeys.has(ownerKey)) continue;
        for (const lineId of cleanup.plan.lineIds) {
          await applyOrderCartCleanupAttempt(params.sessionId, ownerKey, lineId as CartLineId, context);
        }
      }
      const completed = await deps.applySessionCommandForBuyer(
        { ...params, command: { type: "CompleteOrderCartCleanup", completedAt: new Date().toISOString() } },
        context,
      );
      const current = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
      return { ...completed, ...(await cleanupCommitMetadata(params.sessionId, current)) };
    } catch {
      // Completion may have committed before its acknowledgement was lost.
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
            orderHash: params.orderHash,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    } catch {
      // An append can commit and lose its acknowledgement. Recover only actual stored metadata.
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
      await applyOrderCartCleanupAttempt(params.sessionId, state.buyerAccountId!, "checkout", context);
      return result;
    }
    return resumeOrderCartCleanup(params, context);
  };
  return { resumeOrderCartCleanup, recordOrdersCreated };
}

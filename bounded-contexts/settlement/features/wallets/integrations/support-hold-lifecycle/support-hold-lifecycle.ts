import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type {
  SettlementSupportHoldConsumedPayload,
  SettlementSupportHoldPlacedPayload,
  SettlementSupportHoldReleasedPayload,
  SettlementSupportHoldReleaseReason,
} from "@chase-sets/event-core/public-event-payloads";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { assertNever, ensureIsoTimestamp, normalizeRequiredText } from "../../../../support/runtime-support/common";
import { createSettlementSupportHoldId } from "../support-source/support-source-projection";

/**
 * SupportHoldNotice — the Settlement-owned idempotency aggregate that turns a support
 * case's hold lifecycle into support-safe `settlement.support-hold.{placed,released,consumed}.v1`
 * facts (milestone Dispute & Return Resolution Self-Service — settlement support-hold
 * lifecycle slice).
 *
 * Why an aggregate and not a projection: a `settlement_support_holds` row is derived
 * read-model state and cannot publish an event. Notification routing needs a fact it can
 * subscribe to — placed once when the case opens, then exactly one terminal fact when the
 * case ends — that survives subscription replay and duplicate delivery unchanged. One
 * event-sourced stream per hold (`settlement.support-hold-lifecycle-{holdId}`) makes each
 * transition exactly-once: the decider emits nothing on a redelivered open or a second
 * terminal event, and the terminal phase (from a persisted event, never an ambient flag)
 * makes a trailing case-close a no-op on replay.
 *
 * Terminal facts are mutually exclusive and each fires at most once:
 *  - `released` — funds returned to the seller (resolved without a refund, closed with no
 *    resolution, or cancelled). Carries a closed-vocabulary release reason.
 *  - `consumed` — funds applied to the buyer's refund (a refund resolution). Distinct from
 *    `released` so seller copy never says "released back to you" when the funds were spent.
 *
 * Scope: only case-driven holds (those with a `supportRequestId`, i.e. a case deep-link and
 * a buyer/seller pair) become facts here. Provider-risk holds (early fraud warnings, Radar
 * reviews, chargebacks) keep their raw provider ids and payout internals and are deliberately
 * NOT surfaced as support-safe notification facts.
 */

/** Resolution types that keep the hold's funds (the refund/clawback consumes them). */
export const supportHoldRefundResolutionTypes = [
  "full-refund",
  "partial-refund",
  "return-for-refund",
  "cancel-order",
] as const;

export function isRefundResolution(resolutionType: string): boolean {
  return (supportHoldRefundResolutionTypes as readonly string[]).includes(resolutionType.trim());
}

export { createSettlementSupportHoldId };

export function supportHoldLifecycleStreamId(holdId: string): string {
  return `settlement.support-hold-lifecycle-${normalizeRequiredText(holdId, "Support hold lifecycle requires a hold id.")}`;
}

// -------------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------------

export type SupportHoldPhase = "unplaced" | "placed" | "released" | "consumed";

export type SupportHoldRouting = Readonly<{
  holdId: string;
  supportRequestId: string;
  orderId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: string;
}>;

export type SupportHoldLifecycleState = Readonly<{
  phase: SupportHoldPhase;
  routing: SupportHoldRouting | null;
}>;

export const initialSupportHoldLifecycleState: SupportHoldLifecycleState = {
  phase: "unplaced",
  routing: null,
};

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

export type PlaceSupportHoldCommand = Readonly<{
  type: "PlaceSupportHold";
  supportRequestId: string;
  orderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  flowType: string;
  occurredAt: string;
}>;

export type ResolveSupportHoldCommand = Readonly<{
  type: "ResolveSupportHold";
  supportRequestId: string;
  resolutionType: string;
  occurredAt: string;
}>;

export type CloseSupportHoldCommand = Readonly<{
  type: "CloseSupportHold";
  supportRequestId: string;
  occurredAt: string;
}>;

export type CancelSupportHoldCommand = Readonly<{
  type: "CancelSupportHold";
  supportRequestId: string;
  occurredAt: string;
}>;

export type SupportHoldLifecycleCommand =
  | PlaceSupportHoldCommand
  | ResolveSupportHoldCommand
  | CloseSupportHoldCommand
  | CancelSupportHoldCommand;

// -------------------------------------------------------------------------------------------------
// Events (facts)
// -------------------------------------------------------------------------------------------------

export const supportHoldFactTypes = {
  placed: "settlement.support-hold.placed.v1",
  released: "settlement.support-hold.released.v1",
  consumed: "settlement.support-hold.consumed.v1",
} as const;

export type SupportHoldPlacedEvent = DomainEvent<
  typeof supportHoldFactTypes.placed,
  SettlementSupportHoldPlacedPayload
>;
export type SupportHoldReleasedEvent = DomainEvent<
  typeof supportHoldFactTypes.released,
  SettlementSupportHoldReleasedPayload
>;
export type SupportHoldConsumedEvent = DomainEvent<
  typeof supportHoldFactTypes.consumed,
  SettlementSupportHoldConsumedPayload
>;

export type SupportHoldLifecycleEvent = SupportHoldPlacedEvent | SupportHoldReleasedEvent | SupportHoldConsumedEvent;

// -------------------------------------------------------------------------------------------------
// Fact normalizers — validated identically on publish and replay.
// -------------------------------------------------------------------------------------------------

function normalizeEnvelope(input: {
  holdId: string;
  supportRequestId: string;
  orderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  flowType: string;
  occurredAt: string;
}): SettlementSupportHoldPlacedPayload {
  return {
    factSchemaVersion: 1,
    holdId: normalizeRequiredText(input.holdId, "Support hold fact requires a hold id."),
    supportRequestId: normalizeRequiredText(input.supportRequestId, "Support hold fact requires a support request id."),
    orderId: normalizeRequiredText(input.orderId, "Support hold fact requires an order id."),
    buyerAccountId: normalizeRequiredText(
      input.buyerAccountId,
      "Support hold fact requires a buyer account id.",
    ) as AccountId,
    sellerAccountId: normalizeRequiredText(
      input.sellerAccountId,
      "Support hold fact requires a seller account id.",
    ) as AccountId,
    flowType: normalizeRequiredText(input.flowType, "Support hold fact requires a flow type."),
    occurredAt: ensureIsoTimestamp(input.occurredAt, "Support hold fact must record an ISO timestamp."),
  };
}

// -------------------------------------------------------------------------------------------------
// Decide
// -------------------------------------------------------------------------------------------------

function decidePlace(
  state: SupportHoldLifecycleState,
  command: PlaceSupportHoldCommand,
): readonly SupportHoldLifecycleEvent[] {
  // Placed exactly once: a redelivered case-opened is a no-op regardless of phase.
  if (state.phase !== "unplaced") {
    return [];
  }
  return [
    {
      type: supportHoldFactTypes.placed,
      data: normalizeEnvelope({
        holdId: createSettlementSupportHoldId(command.supportRequestId),
        supportRequestId: command.supportRequestId,
        orderId: command.orderId,
        buyerAccountId: command.buyerAccountId,
        sellerAccountId: command.sellerAccountId,
        flowType: command.flowType,
        occurredAt: command.occurredAt,
      }),
    },
  ];
}

function decideResolve(
  state: SupportHoldLifecycleState,
  command: ResolveSupportHoldCommand,
): readonly SupportHoldLifecycleEvent[] {
  // Only a still-active hold reaches a terminal fact, and only once. An out-of-order
  // terminal for a hold that was never placed (no routing captured) is a no-op.
  if (state.phase !== "placed" || state.routing === null) {
    return [];
  }
  const occurredAt = command.occurredAt;
  if (isRefundResolution(command.resolutionType)) {
    return [
      {
        type: supportHoldFactTypes.consumed,
        data: {
          ...normalizeEnvelope({ ...state.routing, occurredAt }),
          resolutionType: normalizeRequiredText(
            command.resolutionType,
            "Support hold consumption requires a resolution type.",
          ),
        },
      },
    ];
  }
  return [releasedFact(state.routing, "support-resolved", occurredAt)];
}

function releasedFact(
  routing: SupportHoldRouting,
  releaseReason: SettlementSupportHoldReleaseReason,
  occurredAt: string,
): SupportHoldReleasedEvent {
  return {
    type: supportHoldFactTypes.released,
    data: { ...normalizeEnvelope({ ...routing, occurredAt }), releaseReason },
  };
}

function decideTerminalRelease(
  state: SupportHoldLifecycleState,
  releaseReason: SettlementSupportHoldReleaseReason,
  occurredAt: string,
): readonly SupportHoldLifecycleEvent[] {
  if (state.phase !== "placed" || state.routing === null) {
    return [];
  }
  return [releasedFact(state.routing, releaseReason, occurredAt)];
}

export const decideSupportHoldLifecycle: AggregateDecider<
  SupportHoldLifecycleState,
  SupportHoldLifecycleCommand,
  SupportHoldLifecycleEvent
> = (state, command) => {
  switch (command.type) {
    case "PlaceSupportHold":
      return decidePlace(state, command);
    case "ResolveSupportHold":
      return decideResolve(state, command);
    case "CloseSupportHold":
      // Only releases when the case closes without a prior terminal (resolved/cancelled).
      return decideTerminalRelease(state, "support-closed", command.occurredAt);
    case "CancelSupportHold":
      return decideTerminalRelease(state, "support-cancelled", command.occurredAt);
    default:
      return assertNever(command);
  }
};

// -------------------------------------------------------------------------------------------------
// Evolve
// -------------------------------------------------------------------------------------------------

export const evolveSupportHoldLifecycle: AggregateEvolver<SupportHoldLifecycleState, SupportHoldLifecycleEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case supportHoldFactTypes.placed: {
      const data = event.data;
      return {
        phase: "placed",
        routing: {
          holdId: data.holdId,
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          buyerAccountId: data.buyerAccountId,
          sellerAccountId: data.sellerAccountId,
          flowType: data.flowType,
        },
      };
    }
    case supportHoldFactTypes.released:
      return { ...state, phase: "released" };
    case supportHoldFactTypes.consumed:
      return { ...state, phase: "consumed" };
    default:
      return assertNever(event);
  }
};

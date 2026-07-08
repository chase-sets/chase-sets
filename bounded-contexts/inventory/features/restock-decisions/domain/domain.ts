import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type {
  InventoryHoldOrderSourceRef,
  InventoryHoldSourceRef,
  InventoryRestockDecisionOutcome,
} from "@chase-sets/event-core/public-event-payloads";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeLabel,
  normalizeOptionalText,
} from "../../../support/runtime-support/common";

export type RestockDecisionSource = "order-cancelled-after-dispatch" | "shipment-returned";

export type RestockDecisionState = Readonly<{
  decisionId: string | null;
  accountId: AccountId | null;
  orderId: string | null;
  itemId: string | null;
  quantity: number;
  source: RestockDecisionSource | null;
  sourceRef: InventoryHoldSourceRef;
  shipmentId: string | null;
  returnReason: string | null;
  status: "pending" | "recorded" | null;
  outcome: InventoryRestockDecisionOutcome | null;
  damageNote: string | null;
}>;

export const initialRestockDecisionState: RestockDecisionState = {
  decisionId: null,
  accountId: null,
  orderId: null,
  itemId: null,
  quantity: 0,
  source: null,
  sourceRef: null,
  shipmentId: null,
  returnReason: null,
  status: null,
  outcome: null,
  damageNote: null,
};

export type MarkRestockDecisionPendingCommand = Readonly<{
  type: "MarkRestockDecisionPending";
  decisionId: string;
  accountId: AccountId;
  orderId: string;
  itemId: string;
  quantity: number;
  source: RestockDecisionSource;
  sourceRef: InventoryHoldSourceRef;
  shipmentId?: string | null;
  returnReason?: string | null;
  pendingAt: string;
}>;

export type RecordRestockDecisionCommand = Readonly<{
  type: "RecordRestockDecision";
  outcome: InventoryRestockDecisionOutcome;
  damageNote?: string | null;
  decidedAt: string;
}>;

export type RestockDecisionCommand = MarkRestockDecisionPendingCommand | RecordRestockDecisionCommand;

export type RestockDecisionPendingEvent = DomainEvent<
  "inventory.restock-decision.pending",
  Readonly<{
    decisionId: string;
    accountId: AccountId;
    orderId: string;
    itemId: string;
    quantity: number;
    source: RestockDecisionSource;
    sourceRef: InventoryHoldSourceRef;
    shipmentId: string | null;
    returnReason: string | null;
    pendingAt: string;
  }>
>;

export type RestockDecisionRecordedEvent = DomainEvent<
  "inventory.restock-decision.recorded",
  Readonly<{
    decisionId: string;
    accountId: AccountId;
    orderId: string;
    itemId: string;
    quantity: number;
    outcome: InventoryRestockDecisionOutcome;
    reason: "return-restocked" | "written-off";
    sourceRef: InventoryHoldSourceRef;
    damageNote: string | null;
    decidedAt: string;
  }>
>;

export type RestockDecisionEvent = RestockDecisionPendingEvent | RestockDecisionRecordedEvent;

export const decideRestockDecision: AggregateDecider<
  RestockDecisionState,
  RestockDecisionCommand,
  RestockDecisionEvent
> = (state, command) => {
  switch (command.type) {
    case "MarkRestockDecisionPending": {
      const normalized = normalizePending(command);
      if (state.status !== null) {
        assert(
          state.accountId === normalized.accountId &&
            state.orderId === normalized.orderId &&
            state.itemId === normalized.itemId &&
            state.quantity === normalized.quantity,
          "Restock decision id was reused for different stock.",
        );
        return [];
      }

      return [
        {
          type: "inventory.restock-decision.pending",
          data: normalized,
        },
      ];
    }
    case "RecordRestockDecision":
      assert(state.status === "pending", "Only pending restock decisions can be recorded.");
      assert(command.outcome === "restocked" || command.outcome === "written-off", "Unsupported restock outcome.");
      return [
        {
          type: "inventory.restock-decision.recorded",
          data: {
            decisionId: state.decisionId!,
            accountId: state.accountId!,
            orderId: state.orderId!,
            itemId: state.itemId!,
            quantity: state.quantity,
            outcome: command.outcome,
            reason: command.outcome === "restocked" ? "return-restocked" : "written-off",
            sourceRef: state.sourceRef,
            damageNote: normalizeOptionalText(command.damageNote),
            decidedAt: normalizeLabel(command.decidedAt),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveRestockDecision: AggregateEvolver<RestockDecisionState, RestockDecisionEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.restock-decision.pending":
      return {
        decisionId: event.data.decisionId,
        accountId: event.data.accountId,
        orderId: event.data.orderId,
        itemId: event.data.itemId,
        quantity: event.data.quantity,
        source: event.data.source,
        sourceRef: event.data.sourceRef,
        shipmentId: event.data.shipmentId,
        returnReason: event.data.returnReason,
        status: "pending",
        outcome: null,
        damageNote: null,
      };
    case "inventory.restock-decision.recorded":
      return {
        ...state,
        status: "recorded",
        outcome: event.data.outcome,
        damageNote: event.data.damageNote,
      };
    default:
      return assertNever(event);
  }
};

function normalizePending(command: MarkRestockDecisionPendingCommand): RestockDecisionPendingEvent["data"] {
  const sourceRef = normalizeOrderSourceRef(command.sourceRef);

  return {
    decisionId: normalizeLabel(command.decisionId),
    accountId: command.accountId,
    orderId: normalizeLabel(command.orderId),
    itemId: normalizeLabel(command.itemId),
    quantity: ensurePositiveInteger(command.quantity, "Restock decisions require a positive quantity."),
    source: command.source,
    sourceRef,
    shipmentId: normalizeOptionalText(command.shipmentId),
    returnReason: normalizeOptionalText(command.returnReason),
    pendingAt: normalizeLabel(command.pendingAt),
  };
}

function normalizeOrderSourceRef(sourceRef: InventoryHoldSourceRef): InventoryHoldOrderSourceRef {
  assert(sourceRef !== null && "orderId" in sourceRef, "Restock decisions require order provenance.");

  return {
    orderId: normalizeLabel(sourceRef.orderId),
    reservationRequestId: normalizeLabel(sourceRef.reservationRequestId),
  };
}

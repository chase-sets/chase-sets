import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  normalizePayoutReviewHoldPayload,
  payoutReviewHoldFactTypes,
  type PayoutReviewHoldPayload,
} from "@chase-sets/event-core/payout-review-hold-facts";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type PayoutReviewHoldState = Readonly<{
  accountId: AccountId | null;
  active: boolean;
  streamExists: boolean;
  hasNonMigrationEvent: boolean;
}>;

export type PayoutReviewHoldView = Readonly<{
  accountId: AccountId | null;
  active: boolean;
  streamExists: boolean;
  hasNonMigrationEvent: boolean;
  reason: string | null;
  source: PayoutReviewHoldCommand["source"] | null;
  sourceReference: string | null;
  actorUserId: string | null;
  occurredAt: string | null;
  version: number;
}>;

export const initialPayoutReviewHoldState: PayoutReviewHoldState = {
  accountId: null,
  active: false,
  streamExists: false,
  hasNonMigrationEvent: false,
};

export type PlacePayoutReviewHoldCommand = Readonly<{
  type: "PlacePayoutReviewHold";
  accountId: AccountId;
  reason: string;
  source: "operator" | "risk-alert" | "badge-migration";
  sourceReference?: string | null;
}>;
export type ReleasePayoutReviewHoldCommand = Readonly<{
  type: "ReleasePayoutReviewHold";
  accountId: AccountId;
  reason: string;
  source: "operator" | "risk-alert" | "badge-migration";
  sourceReference?: string | null;
}>;
export type PayoutReviewHoldCommand = PlacePayoutReviewHoldCommand | ReleasePayoutReviewHoldCommand;
export type PayoutReviewHoldPlacedEvent = DomainEvent<typeof payoutReviewHoldFactTypes.placed, PayoutReviewHoldPayload>;
export type PayoutReviewHoldReleasedEvent = DomainEvent<
  typeof payoutReviewHoldFactTypes.released,
  PayoutReviewHoldPayload
>;
export type PayoutReviewHoldEvent = PayoutReviewHoldPlacedEvent | PayoutReviewHoldReleasedEvent;

function payload(command: {
  accountId: AccountId;
  reason: string;
  source: PayoutReviewHoldCommand["source"];
  sourceReference?: string | null;
}): PayoutReviewHoldPayload {
  return normalizePayoutReviewHoldPayload({ ...command, sourceReference: command.sourceReference ?? null });
}

export const decidePayoutReviewHold: AggregateDecider<
  PayoutReviewHoldState,
  PayoutReviewHoldCommand,
  PayoutReviewHoldEvent
> = (state, command) => {
  if (state.accountId !== null && state.accountId !== command.accountId)
    throw new Error("Payout review hold stream account does not match command.");
  const data = payload(command);
  // Badge migration only converges a hold no operator or risk alert has decided, and never writes a tombstone.
  if (command.source === "badge-migration" && state.hasNonMigrationEvent) return [];
  if (command.type === "PlacePayoutReviewHold") {
    return state.active ? [] : [{ type: payoutReviewHoldFactTypes.placed, data }];
  }
  if (state.active) return [{ type: payoutReviewHoldFactTypes.released, data }];
  if (!state.streamExists && command.source !== "badge-migration") {
    return [{ type: payoutReviewHoldFactTypes.released, data }];
  }
  return [];
};

export const evolvePayoutReviewHold: AggregateEvolver<PayoutReviewHoldState, PayoutReviewHoldEvent> = (
  state,
  event,
) => ({
  accountId: event.data.accountId,
  active: event.type === payoutReviewHoldFactTypes.placed,
  streamExists: true,
  hasNonMigrationEvent: state.hasNonMigrationEvent || event.data.source !== "badge-migration",
});

export function payoutReviewHoldStreamId(accountId: string): string {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("Payout review hold stream requires an account id.");
  return `settlement.payout-review-hold-${normalized}`;
}

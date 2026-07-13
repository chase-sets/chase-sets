import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

/**
 * The Seller Capacity Signal is ordering's edge-triggered At Capacity
 * broadcast for a seller: buyer-facing surfaces (discovery, checkout) key
 * their "check back soon" messaging off `ordering.seller-capacity.reached`
 * / `.cleared` rather than recomputing Open Order counts themselves. The
 * signal is derived state -- the truthful count lives in
 * `ordering_seller_open_order_claims` (api/order-capacity.ts) -- so this
 * decider only ever no-ops or emits when the observed at-capacity state
 * actually flips. That idempotency is what makes "exactly one event per
 * crossing" hold under concurrent claim/release churn: every caller
 * recomputes the current truth and reports it here, but only the caller
 * that actually changed the state produces an event.
 */
export type SellerCapacitySignalState = Readonly<{
  accountId: string | null;
  atCapacity: boolean;
}>;

export const initialSellerCapacitySignalState: SellerCapacitySignalState = {
  accountId: null,
  atCapacity: false,
};

export type MarkSellerAtCapacityCommand = Readonly<{
  type: "MarkSellerAtCapacity";
  accountId: string;
}>;

export type ClearSellerAtCapacityCommand = Readonly<{
  type: "ClearSellerAtCapacity";
  accountId: string;
}>;

export type SellerCapacitySignalCommand = MarkSellerAtCapacityCommand | ClearSellerAtCapacityCommand;

export type SellerCapacityReachedEvent = DomainEvent<
  "ordering.seller-capacity.reached",
  {
    accountId: string;
  }
>;

export type SellerCapacityClearedEvent = DomainEvent<
  "ordering.seller-capacity.cleared",
  {
    accountId: string;
  }
>;

export type SellerCapacitySignalEvent = SellerCapacityReachedEvent | SellerCapacityClearedEvent;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled seller capacity signal command: ${String(value)}`);
}

function normalizeAccountId(accountId: string) {
  const normalized = accountId.trim();
  assert(normalized.length > 0, "Account id is required.");
  return normalized;
}

export const decideSellerCapacitySignal: AggregateDecider<
  SellerCapacitySignalState,
  SellerCapacitySignalCommand,
  SellerCapacitySignalEvent
> = (state, command) => {
  switch (command.type) {
    case "MarkSellerAtCapacity": {
      const accountId = normalizeAccountId(command.accountId);
      if (state.atCapacity) {
        return [];
      }
      return [
        {
          type: "ordering.seller-capacity.reached",
          data: { accountId },
        },
      ];
    }
    case "ClearSellerAtCapacity": {
      const accountId = normalizeAccountId(command.accountId);
      if (!state.atCapacity) {
        return [];
      }
      return [
        {
          type: "ordering.seller-capacity.cleared",
          data: { accountId },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveSellerCapacitySignal: AggregateEvolver<SellerCapacitySignalState, SellerCapacitySignalEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "ordering.seller-capacity.reached":
      return { accountId: event.data.accountId, atCapacity: true };
    case "ordering.seller-capacity.cleared":
      return { accountId: event.data.accountId, atCapacity: false };
    default:
      return assertNever(event);
  }
};

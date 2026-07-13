import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

/**
 * Seller Order Capacity is the seller-owned setting for how many
 * concurrently Open Orders an account will accept before new order intake
 * pauses (the Order Capacity glossary term). This slice ships only the
 * setting and its events: no stream exists until a seller sets a cap for
 * the first time, and `maxOpenOrders: null` means unlimited (the default).
 * Nothing consumes these facts yet -- enforcement (Open Order counting, the
 * At Capacity signal, and refusing new order intake) is a later slice.
 */
export type SellerOrderCapacityState = Readonly<{
  accountId: string | null;
  maxOpenOrders: number | null;
}>;

export const initialSellerOrderCapacityState: SellerOrderCapacityState = {
  accountId: null,
  maxOpenOrders: null,
};

export type SetSellerOrderCapacityCommand = Readonly<{
  type: "SetSellerOrderCapacity";
  accountId: string;
  maxOpenOrders: number;
}>;

export type ClearSellerOrderCapacityCommand = Readonly<{
  type: "ClearSellerOrderCapacity";
  accountId: string;
}>;

export type SellerOrderCapacityCommand = SetSellerOrderCapacityCommand | ClearSellerOrderCapacityCommand;

export type SellerOrderCapacitySetEvent = DomainEvent<
  "marketplace.seller-order-capacity.set",
  {
    accountId: string;
    maxOpenOrders: number;
  }
>;

export type SellerOrderCapacityClearedEvent = DomainEvent<
  "marketplace.seller-order-capacity.cleared",
  {
    accountId: string;
  }
>;

export type SellerOrderCapacityEvent = SellerOrderCapacitySetEvent | SellerOrderCapacityClearedEvent;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled seller order capacity command: ${String(value)}`);
}

function normalizeAccountId(accountId: string) {
  const normalized = accountId.trim();
  assert(normalized.length > 0, "Account id is required.");
  return normalized;
}

function normalizeMaxOpenOrders(value: number) {
  assert(Number.isInteger(value) && value >= 1, "Order capacity must be a whole number of at least 1.");
  return value;
}

export const decideSellerOrderCapacity: AggregateDecider<
  SellerOrderCapacityState,
  SellerOrderCapacityCommand,
  SellerOrderCapacityEvent
> = (state, command) => {
  switch (command.type) {
    case "SetSellerOrderCapacity": {
      const accountId = normalizeAccountId(command.accountId);
      const maxOpenOrders = normalizeMaxOpenOrders(command.maxOpenOrders);

      // Idempotent re-set: setting the same cap again is a no-op, not a
      // fresh fact -- protects against retried requests double-appending.
      if (state.maxOpenOrders === maxOpenOrders) {
        return [];
      }

      return [
        {
          type: "marketplace.seller-order-capacity.set",
          data: { accountId, maxOpenOrders },
        },
      ];
    }
    case "ClearSellerOrderCapacity": {
      const accountId = normalizeAccountId(command.accountId);

      // Already unlimited (never set, or already cleared) -- no-op.
      if (state.maxOpenOrders === null) {
        return [];
      }

      return [
        {
          type: "marketplace.seller-order-capacity.cleared",
          data: { accountId },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveSellerOrderCapacity: AggregateEvolver<SellerOrderCapacityState, SellerOrderCapacityEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "marketplace.seller-order-capacity.set":
      return {
        accountId: event.data.accountId,
        maxOpenOrders: event.data.maxOpenOrders,
      };
    case "marketplace.seller-order-capacity.cleared":
      return {
        accountId: event.data.accountId,
        maxOpenOrders: null,
      };
    default:
      return assertNever(event);
  }
};

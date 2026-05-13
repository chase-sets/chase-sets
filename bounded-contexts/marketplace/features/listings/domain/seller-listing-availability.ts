import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

export type SellerListingAvailabilityStatus = "available" | "unavailable";

export type SellerListingAvailabilityReasonCategory =
  | "travel"
  | "audit"
  | "operations"
  | "other";

export type SellerListingAvailabilityState = Readonly<{
  accountId: string | null;
  status: SellerListingAvailabilityStatus;
  disabledReasonCategory: SellerListingAvailabilityReasonCategory | null;
  availableAgainOn: string | null;
  disabledAt: string | null;
  enabledAt: string | null;
}>;

export const initialSellerListingAvailabilityState: SellerListingAvailabilityState = {
  accountId: null,
  status: "available",
  disabledReasonCategory: null,
  availableAgainOn: null,
  disabledAt: null,
  enabledAt: null,
};

export type DisableSellerListingAvailabilityCommand = Readonly<{
  type: "DisableSellerListingAvailability";
  accountId: string;
  reasonCategory: SellerListingAvailabilityReasonCategory | null;
  availableAgainOn: string | null;
  disabledAt: string;
}>;

export type EnableSellerListingAvailabilityCommand = Readonly<{
  type: "EnableSellerListingAvailability";
  accountId: string;
  enabledAt: string;
}>;

export type SellerListingAvailabilityCommand =
  | DisableSellerListingAvailabilityCommand
  | EnableSellerListingAvailabilityCommand;

export type SellerListingAvailabilityDisabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.disabled",
  {
    accountId: string;
    reasonCategory: SellerListingAvailabilityReasonCategory | null;
    availableAgainOn: string | null;
    disabledAt: string;
  }
>;

export type SellerListingAvailabilityEnabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.enabled",
  {
    accountId: string;
    enabledAt: string;
  }
>;

export type SellerListingAvailabilityEvent =
  | SellerListingAvailabilityDisabledEvent
  | SellerListingAvailabilityEnabledEvent;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled seller listing availability command: ${String(value)}`);
}

function normalizeAccountId(accountId: string) {
  const normalized = accountId.trim();
  assert(normalized.length > 0, "Account id is required.");
  return normalized;
}

function normalizeIsoDate(value: string | null) {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  assert(/^\d{4}-\d{2}-\d{2}$/.test(normalized), "Available again date must use YYYY-MM-DD.");
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  assert(!Number.isNaN(parsed.valueOf()), "Available again date is invalid.");
  assert(parsed.toISOString().slice(0, 10) === normalized, "Available again date is invalid.");
  return normalized;
}

function normalizeReasonCategory(
  value: SellerListingAvailabilityReasonCategory | null,
) {
  return value;
}

export const decideSellerListingAvailability: AggregateDecider<
  SellerListingAvailabilityState,
  SellerListingAvailabilityCommand,
  SellerListingAvailabilityEvent
> = (state, command) => {
  switch (command.type) {
    case "DisableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const reasonCategory = normalizeReasonCategory(command.reasonCategory);
      const availableAgainOn = normalizeIsoDate(command.availableAgainOn);
      const disabledAt = command.disabledAt.trim();
      assert(disabledAt.length > 0, "Disabled timestamp is required.");

      if (
        state.status === "unavailable" &&
        state.disabledReasonCategory === reasonCategory &&
        state.availableAgainOn === availableAgainOn
      ) {
        return [];
      }

      return [{
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId,
          reasonCategory,
          availableAgainOn,
          disabledAt,
        },
      }];
    }
    case "EnableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const enabledAt = command.enabledAt.trim();
      assert(enabledAt.length > 0, "Enabled timestamp is required.");

      if (state.status === "available") {
        return [];
      }

      return [{
        type: "marketplace.seller-listing-availability.enabled",
        data: {
          accountId,
          enabledAt,
        },
      }];
    }
    default:
      return assertNever(command);
  }
};

export const evolveSellerListingAvailability: AggregateEvolver<
  SellerListingAvailabilityState,
  SellerListingAvailabilityEvent
> = (state, event) => {
  switch (event.type) {
    case "marketplace.seller-listing-availability.disabled":
      return {
        accountId: event.data.accountId,
        status: "unavailable",
        disabledReasonCategory: event.data.reasonCategory,
        availableAgainOn: event.data.availableAgainOn,
        disabledAt: event.data.disabledAt,
        enabledAt: state.enabledAt,
      };
    case "marketplace.seller-listing-availability.enabled":
      return {
        accountId: event.data.accountId,
        status: "available",
        disabledReasonCategory: null,
        availableAgainOn: null,
        disabledAt: state.disabledAt,
        enabledAt: event.data.enabledAt,
      };
    default:
      return assertNever(event);
  }
};

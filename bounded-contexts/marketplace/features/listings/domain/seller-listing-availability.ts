import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

export type SellerListingAvailabilityStatus = "available" | "unavailable";

export type SellerListingAvailabilityReasonCategory = "travel" | "audit" | "operations" | "other";

/**
 * Who or what set the current `.enabled` fact. `"seller"` is an explicit
 * seller action; `"scheduled"` is an automated resume triggered by an away
 * window sweep. Legacy events recorded before this field existed carry no
 * `enabledBy` payload key and read back as `"seller"` -- every enable before
 * an automated sweep existed was, definitionally, a seller action.
 */
export type SellerListingAvailabilityEnabledBy = "seller" | "scheduled";

export type SellerListingAvailabilityState = Readonly<{
  accountId: string | null;
  status: SellerListingAvailabilityStatus;
  disabledReasonCategory: SellerListingAvailabilityReasonCategory | null;
  availableAgainOn: string | null;
  /**
   * The authoritative resume instant. Only present when the disable that
   * produced the current `unavailable` state carried one -- legacy
   * `.disabled` events recorded before this field existed leave it `null`
   * even when `availableAgainOn` is set, per the replay-safe legacy ruling:
   * a bare `availableAgainOn` date never participates in automated resume.
   */
  availableAgainAt: string | null;
  disabledAt: string | null;
  enabledAt: string | null;
  enabledBy: SellerListingAvailabilityEnabledBy | null;
}>;

export const initialSellerListingAvailabilityState: SellerListingAvailabilityState = {
  accountId: null,
  status: "available",
  disabledReasonCategory: null,
  availableAgainOn: null,
  availableAgainAt: null,
  disabledAt: null,
  enabledAt: null,
  enabledBy: null,
};

export type DisableSellerListingAvailabilityCommand = Readonly<{
  type: "DisableSellerListingAvailability";
  accountId: string;
  reasonCategory: SellerListingAvailabilityReasonCategory | null;
  availableAgainOn: string | null;
  /**
   * The authoritative resume instant, captured at the edge (the seller's
   * local start-of-day for their chosen date, converted to an instant
   * client-side). Optional: `null` means an indefinite away period with no
   * planned return. When present it must be strictly after `disabledAt`.
   */
  availableAgainAt: string | null;
  disabledAt: string;
}>;

export type EnableSellerListingAvailabilityCommand = Readonly<{
  type: "EnableSellerListingAvailability";
  accountId: string;
  enabledAt: string;
  enabledBy: SellerListingAvailabilityEnabledBy;
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
    availableAgainAt: string | null;
    disabledAt: string;
  }
>;

export type SellerListingAvailabilityEnabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.enabled",
  {
    accountId: string;
    enabledAt: string;
    enabledBy: SellerListingAvailabilityEnabledBy;
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

/**
 * Normalizes the authoritative resume instant. The domain accepts only a
 * fully-formed instant -- it never infers a timezone from a bare date, that
 * conversion happens client-side where the seller's local timezone is
 * actually known.
 */
function normalizeAvailableAgainAt(value: string | null) {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  assert(!Number.isNaN(parsed.valueOf()), "Available again instant is invalid.");
  return parsed.toISOString();
}

/**
 * The instant is authoritative once present, so the display-only
 * `availableAgainOn` date is derived from it rather than trusted verbatim
 * from the caller -- the two fields can never disagree. This is a UTC
 * calendar-day slice of the instant: display continuity only, not a
 * timezone-accurate reconstruction of the seller's local date (which lives
 * client-side, where the instant was produced).
 */
function resolveAvailableAgainOn(availableAgainOn: string | null, availableAgainAt: string | null) {
  if (availableAgainAt !== null) {
    return availableAgainAt.slice(0, 10);
  }

  return normalizeIsoDate(availableAgainOn);
}

function normalizeReasonCategory(value: SellerListingAvailabilityReasonCategory | null) {
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
      const disabledAt = command.disabledAt.trim();
      assert(disabledAt.length > 0, "Disabled timestamp is required.");

      const availableAgainAt = normalizeAvailableAgainAt(command.availableAgainAt);
      if (availableAgainAt !== null) {
        assert(
          new Date(availableAgainAt).valueOf() > new Date(disabledAt).valueOf(),
          "Available again instant must be after the disable time.",
        );
      }
      const availableAgainOn = resolveAvailableAgainOn(command.availableAgainOn, availableAgainAt);

      // A disable command while already unavailable is a refresh -- a seller
      // extending or shortening time away -- not a no-op, UNLESS every
      // field is byte-identical to the current state (idempotent
      // double-submit protection, e.g. a retried request).
      if (
        state.status === "unavailable" &&
        state.disabledReasonCategory === reasonCategory &&
        state.availableAgainOn === availableAgainOn &&
        state.availableAgainAt === availableAgainAt
      ) {
        return [];
      }

      return [
        {
          type: "marketplace.seller-listing-availability.disabled",
          data: {
            accountId,
            reasonCategory,
            availableAgainOn,
            availableAgainAt,
            disabledAt,
          },
        },
      ];
    }
    case "EnableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const enabledAt = command.enabledAt.trim();
      assert(enabledAt.length > 0, "Enabled timestamp is required.");

      if (state.status === "available") {
        return [];
      }

      return [
        {
          type: "marketplace.seller-listing-availability.enabled",
          data: {
            accountId,
            enabledAt,
            enabledBy: command.enabledBy,
          },
        },
      ];
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
        // Legacy ruling: events recorded before this field existed carry no
        // `availableAgainAt` payload key at all, so it reads back as `null`
        // here -- informational-only, never a resume trigger.
        availableAgainAt: event.data.availableAgainAt ?? null,
        disabledAt: event.data.disabledAt,
        enabledAt: state.enabledAt,
        enabledBy: state.enabledBy,
      };
    case "marketplace.seller-listing-availability.enabled":
      return {
        accountId: event.data.accountId,
        status: "available",
        disabledReasonCategory: null,
        availableAgainOn: null,
        availableAgainAt: null,
        disabledAt: state.disabledAt,
        enabledAt: event.data.enabledAt,
        // Legacy ruling: events recorded before this field existed carry no
        // `enabledBy` payload key, so they read back as `"seller"` -- every
        // enable before an automated sweep existed was a seller action.
        enabledBy: event.data.enabledBy ?? "seller",
      };
    default:
      return assertNever(event);
  }
};

import { MarketplaceListingDomainError } from "./listing-error";
import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

export type SellerListingAvailabilityStatus = "available" | "unavailable";
export type AwayScope = "listings" | "offers" | "both";
type AwaySide = Exclude<AwayScope, "both">;
const awaySides = ["listings", "offers"] as const;

export type SellerListingAvailabilityReasonCategory = "travel" | "audit" | "operations" | "other";

/**
 * Who or what set the current `.enabled` fact. `"seller"` is an explicit
 * seller action; `"scheduled"` is an automated resume triggered by an away
 * window sweep. Legacy events recorded before this field existed carry no
 * `enabledBy` payload key and read back as `"seller"` -- every enable before
 * an automated sweep existed was, definitionally, a seller action.
 */
export type SellerListingAvailabilityEnabledBy = "seller" | "scheduled";

/**
 * Who or what set the current `.disabled` fact. `"seller"` is an explicit
 * seller action (including a same-day disable that pre-empts a pending Away
 * Window); `"scheduled"` is the Away Window start sweep consuming its own
 * pending window. Legacy events recorded before this field existed carry no
 * `disabledBy` payload key and read back as `"seller"` -- every disable
 * before Away Windows existed was, definitionally, a seller action.
 */
export type SellerListingAvailabilityDisabledBy = "seller" | "scheduled";

/**
 * A seller-scheduled future away period: Seller Listing Availability will
 * auto-disable at `startsAt` and, once away, ride the existing Resume
 * Instant sweep back to available at `endsAt` (or stay away indefinitely
 * when `endsAt` is `null`). At most one pending window may exist at a time.
 */
export type SellerListingAvailabilityAwayWindow = Readonly<{
  startsAt: string;
  endsAt: string | null;
  reasonCategory: SellerListingAvailabilityReasonCategory;
  scope?: AwayScope;
}>;

type AvailabilityDetails = Readonly<{
  status: SellerListingAvailabilityStatus;
  disabledReasonCategory: SellerListingAvailabilityReasonCategory | null;
  availableAgainOn: string | null;
  availableAgainAt: string | null;
  disabledAt: string | null;
  disabledBy: SellerListingAvailabilityDisabledBy | null;
  enabledAt: string | null;
  enabledBy: SellerListingAvailabilityEnabledBy | null;
}>;

export type SellerListingAvailabilityState = Readonly<{
  accountId: string | null;
  offers: AvailabilityDetails;
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
  disabledBy: SellerListingAvailabilityDisabledBy | null;
  enabledAt: string | null;
  enabledBy: SellerListingAvailabilityEnabledBy | null;
  /**
   * The scheduled Away Window, if any. Only ever set while `status` is
   * `"available"` -- scheduling requires availability, and any disable
   * (manual or scheduled) consumes it.
   */
  pendingAwayWindow: SellerListingAvailabilityAwayWindow | null;
}>;

const initialAvailabilityDetails: AvailabilityDetails = {
  status: "available",
  disabledReasonCategory: null,
  availableAgainOn: null,
  availableAgainAt: null,
  disabledAt: null,
  disabledBy: null,
  enabledAt: null,
  enabledBy: null,
};

export const initialSellerListingAvailabilityState: SellerListingAvailabilityState = {
  ...initialAvailabilityDetails,
  accountId: null,
  offers: initialAvailabilityDetails,
  pendingAwayWindow: null,
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
  /** Defaults to `"seller"`; the Away Window start sweep passes `"scheduled"`. */
  disabledBy: SellerListingAvailabilityDisabledBy;
  scope?: AwayScope;
  /** Internal disables never restore a side. */
  preserveOtherSide?: boolean;
  /**
   * The pending Away Window's `startsAt` the caller observed as due, for
   * compare-and-swap protection against a lost race. When present, the
   * command only disables if it still matches the CURRENT aggregate's
   * `pendingAwayWindow.startsAt` -- otherwise the seller cancelled or
   * replaced the window between the caller's read and this command
   * reaching the aggregate, and the command no-ops instead of disabling on
   * a stale premise. Omitted by every seller-initiated disable: a human
   * clicking a button has nothing to race against.
   */
  dueBy?: string | null;
}>;

export type EnableSellerListingAvailabilityCommand = Readonly<{
  type: "EnableSellerListingAvailability";
  accountId: string;
  enabledAt: string;
  enabledBy: SellerListingAvailabilityEnabledBy;
  scope?: AwayScope;
  /**
   * The Resume Instant the caller observed as due, for compare-and-swap
   * protection against a lost race. When present, the command only enables
   * if it still matches the CURRENT aggregate's `availableAgainAt` --
   * otherwise the seller re-disabled or pushed the Resume Instant forward
   * between the caller's read and this command reaching the aggregate, and
   * the command no-ops instead of overriding that concurrent seller action.
   * Omitted by every seller-initiated enable: a human clicking a button has
   * nothing to race against.
   */
  dueBy?: string | null;
}>;

export type ScheduleSellerAwayWindowCommand = Readonly<{
  type: "ScheduleSellerAwayWindow";
  accountId: string;
  /** Must be strictly after `scheduledAt`. */
  startsAt: string;
  /** Optional: `null` means an indefinite away period with no planned return. Must be strictly after `startsAt` when present. */
  endsAt: string | null;
  reasonCategory: SellerListingAvailabilityReasonCategory;
  /** The instant the command was issued, used to validate `startsAt` is genuinely in the future. */
  scheduledAt: string;
  scope?: AwayScope;
}>;

export type CancelScheduledAwayWindowCommand = Readonly<{
  type: "CancelScheduledAwayWindow";
  accountId: string;
  cancelledAt: string;
}>;

export type SellerListingAvailabilityCommand =
  | DisableSellerListingAvailabilityCommand
  | EnableSellerListingAvailabilityCommand
  | ScheduleSellerAwayWindowCommand
  | CancelScheduledAwayWindowCommand;

export type SellerListingAvailabilityDisabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.disabled",
  {
    accountId: string;
    reasonCategory: SellerListingAvailabilityReasonCategory | null;
    availableAgainOn: string | null;
    availableAgainAt: string | null;
    disabledAt: string;
    disabledBy: SellerListingAvailabilityDisabledBy;
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

type SellerOffersDisabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.offers-disabled",
  SellerListingAvailabilityDisabledEvent["data"]
>;
type SellerOffersEnabledEvent = DomainEvent<
  "marketplace.seller-listing-availability.offers-enabled",
  SellerListingAvailabilityEnabledEvent["data"]
>;

export type SellerListingAvailabilityAwayWindowScheduledEvent = DomainEvent<
  "marketplace.seller-listing-availability.away-window-scheduled",
  {
    accountId: string;
    startsAt: string;
    endsAt: string | null;
    reasonCategory: SellerListingAvailabilityReasonCategory;
    scheduledAt: string;
    scope?: AwayScope;
  }
>;

export type SellerListingAvailabilityAwayWindowCancelledEvent = DomainEvent<
  "marketplace.seller-listing-availability.away-window-cancelled",
  {
    accountId: string;
    cancelledAt: string;
  }
>;

export type SellerListingAvailabilityCommitmentCheckedEvent = DomainEvent<
  "marketplace.seller-listing-availability.commitment-checked",
  {
    offerId: string;
    listingId: string;
    checkedAt: string;
  }
>;

export type SellerListingAvailabilityEvent =
  | SellerListingAvailabilityDisabledEvent
  | SellerListingAvailabilityEnabledEvent
  | SellerOffersDisabledEvent
  | SellerOffersEnabledEvent
  | SellerListingAvailabilityAwayWindowScheduledEvent
  | SellerListingAvailabilityAwayWindowCancelledEvent
  | SellerListingAvailabilityCommitmentCheckedEvent;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new MarketplaceListingDomainError("command-rejected", message);
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
 * Normalizes a fully-formed instant. The domain never infers a timezone
 * from a bare date -- that conversion happens client-side where the
 * seller's local timezone is actually known. Shared by the Resume Instant
 * and the Away Window's `startsAt`/`endsAt` boundaries.
 */
function normalizeInstant(value: string | null, message: string) {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  assert(!Number.isNaN(parsed.valueOf()), message);
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

/**
 * Compares two instants for compare-and-swap purposes by parsed value, not
 * raw string equality. A `dueBy` observed via a due-index SQL query comes
 * back through Postgres's native timestamptz text format (e.g.
 * `"2030-01-01 00:00:00+00"`), which never byte-matches the ISO-8601 string
 * the aggregate stores (e.g. `"2030-01-01T00:00:00.000Z"`) even when both
 * represent the exact same instant -- a strict `!==` would make every CAS
 * check spuriously no-op.
 */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  const parsedA = new Date(a).valueOf();
  const parsedB = new Date(b).valueOf();
  return !Number.isNaN(parsedA) && !Number.isNaN(parsedB) && parsedA === parsedB;
}

function enableSide(
  side: AwaySide,
  data: SellerListingAvailabilityEnabledEvent["data"],
): SellerListingAvailabilityEvent {
  return side === "listings"
    ? { type: "marketplace.seller-listing-availability.enabled", data }
    : { type: "marketplace.seller-listing-availability.offers-enabled", data };
}

export const decideSellerListingAvailability: AggregateDecider<
  SellerListingAvailabilityState,
  SellerListingAvailabilityCommand,
  SellerListingAvailabilityEvent
> = (state, command) => {
  switch (command.type) {
    case "DisableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const reasonCategory = command.reasonCategory;
      const disabledAt = command.disabledAt.trim();
      assert(disabledAt.length > 0, "Disabled timestamp is required.");
      const disabledBy = command.disabledBy;

      // Compare-and-swap for a scheduled (Away Window start sweep) disable:
      // when the caller supplies the pending window's startsAt it observed
      // as due, a mismatch against the CURRENT aggregate means the window
      // was cancelled or replaced between the sweep's read and this
      // command -- no-op rather than disable on a stale premise.
      if (command.dueBy !== undefined && !sameInstant(command.dueBy, state.pendingAwayWindow?.startsAt ?? null)) {
        return [];
      }

      const availableAgainAt = normalizeAvailableAgainAt(command.availableAgainAt);
      if (disabledBy === "scheduled" && command.dueBy !== undefined) {
        const window = state.pendingAwayWindow;
        if (
          !window ||
          (window.scope ?? "listings") !== (command.scope ?? "listings") ||
          window.reasonCategory !== reasonCategory ||
          !sameInstant(window.endsAt, availableAgainAt)
        )
          return [];
      }
      if (availableAgainAt !== null) {
        assert(
          new Date(availableAgainAt).valueOf() > new Date(disabledAt).valueOf(),
          "Available again instant must be after the disable time.",
        );
      }
      const availableAgainOn = resolveAvailableAgainOn(command.availableAgainOn, availableAgainAt);

      const scope = command.scope ?? "listings";
      const replaceScope = disabledBy === "seller" && !command.preserveOtherSide;
      const events: SellerListingAvailabilityEvent[] = [];
      for (const side of awaySides) {
        const current = side === "listings" ? state : state.offers;
        if (scope !== "both" && scope !== side) {
          if (replaceScope && current.status === "unavailable") {
            events.push(enableSide(side, { accountId, enabledAt: disabledAt, enabledBy: "seller" }));
          }
          continue;
        }

        // Selecting Offers alone without a new date retains any existing Offers deadline.
        const retainDeadline =
          replaceScope &&
          scope === "offers" &&
          current.status === "unavailable" &&
          availableAgainAt === null &&
          availableAgainOn === null;
        const until = retainDeadline ? current.availableAgainAt : availableAgainAt;
        const on = retainDeadline ? current.availableAgainOn : availableAgainOn;
        if (
          current.status === "unavailable" &&
          current.disabledReasonCategory === reasonCategory &&
          current.availableAgainOn === on &&
          current.availableAgainAt === until
        )
          continue;
        if (retainDeadline && until !== null && new Date(until).valueOf() <= new Date(disabledAt).valueOf()) continue;
        const data = {
          accountId,
          reasonCategory,
          availableAgainOn: on,
          availableAgainAt: until,
          disabledAt,
          disabledBy,
        };
        events.push(
          side === "listings"
            ? { type: "marketplace.seller-listing-availability.disabled", data }
            : { type: "marketplace.seller-listing-availability.offers-disabled", data },
        );
      }

      // A manual disable while a window is pending pre-empts it: the seller
      // went away right now by their own action, so the future-dated window
      // is cancelled, not fulfilled -- emit an explicit cancellation fact.
      // A scheduled disable (the window-start sweep consuming its own due
      // window) needs no separate cancellation event: the evolver clears
      // the pending window as part of applying the disabled fact itself.
      if (disabledBy === "seller" && state.pendingAwayWindow !== null) {
        events.push({
          type: "marketplace.seller-listing-availability.away-window-cancelled",
          data: { accountId, cancelledAt: disabledAt },
        });
      }

      return events;
    }
    case "EnableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const enabledAt = command.enabledAt.trim();
      assert(enabledAt.length > 0, "Enabled timestamp is required.");

      const scope = command.scope ?? "both";
      return awaySides.flatMap((side) => {
        const current = side === "listings" ? state : state.offers;
        if (
          (scope !== "both" && scope !== side) ||
          current.status === "available" ||
          (command.dueBy !== undefined &&
            (command.dueBy === null || !sameInstant(command.dueBy, current.availableAgainAt)))
        )
          return [];
        return [enableSide(side, { accountId, enabledAt, enabledBy: command.enabledBy })];
      });
    }
    case "ScheduleSellerAwayWindow": {
      const accountId = normalizeAccountId(command.accountId);
      const scheduledAt = command.scheduledAt.trim();
      assert(scheduledAt.length > 0, "Scheduled timestamp is required.");
      const startsAt = normalizeInstant(command.startsAt, "Away window start instant is invalid.");
      assert(startsAt !== null, "Away window start instant is required.");
      assert(
        new Date(startsAt).valueOf() > new Date(scheduledAt).valueOf(),
        "Away window start must be in the future.",
      );
      const endsAt = normalizeInstant(command.endsAt, "Away window end instant is invalid.");
      if (endsAt !== null) {
        assert(new Date(endsAt).valueOf() > new Date(startsAt).valueOf(), "Away window end must be after the start.");
      }
      assert(state.status === "available", "Scheduling an away window requires listings to currently be available.");
      assert(
        state.offers.status === "available",
        "Scheduling an away window requires offers to currently be available.",
      );
      assert(
        state.pendingAwayWindow === null,
        "Cancel the existing scheduled away window before scheduling a new one.",
      );

      return [
        {
          type: "marketplace.seller-listing-availability.away-window-scheduled",
          data: {
            accountId,
            startsAt,
            endsAt,
            reasonCategory: command.reasonCategory,
            scheduledAt,
            ...(command.scope === undefined ? {} : { scope: command.scope }),
          },
        },
      ];
    }
    case "CancelScheduledAwayWindow": {
      const accountId = normalizeAccountId(command.accountId);
      const cancelledAt = command.cancelledAt.trim();
      assert(cancelledAt.length > 0, "Cancelled timestamp is required.");

      if (state.pendingAwayWindow === null) {
        return [];
      }

      return [
        {
          type: "marketplace.seller-listing-availability.away-window-cancelled",
          data: { accountId, cancelledAt },
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
        ...state,
        accountId: event.data.accountId,
        status: "unavailable",
        disabledReasonCategory: event.data.reasonCategory,
        availableAgainOn: event.data.availableAgainOn,
        // Legacy ruling: events recorded before this field existed carry no
        // `availableAgainAt` payload key at all, so it reads back as `null`
        // here -- informational-only, never a resume trigger.
        availableAgainAt: event.data.availableAgainAt ?? null,
        disabledAt: event.data.disabledAt,
        // Legacy ruling: events recorded before this field existed carry no
        // `disabledBy` payload key, so they read back as `"seller"`.
        disabledBy: event.data.disabledBy ?? "seller",
        enabledAt: state.enabledAt,
        enabledBy: state.enabledBy,
        // The disable consumes any pending window -- whether it's the
        // window's own start sweep firing (implicit consumption) or a
        // manual disable that already emitted an explicit
        // `.away-window-cancelled` fact alongside this one, the window's
        // relevance ends here either way.
        pendingAwayWindow: null,
      };
    case "marketplace.seller-listing-availability.enabled":
      return {
        ...state,
        accountId: event.data.accountId,
        status: "available",
        disabledReasonCategory: null,
        availableAgainOn: null,
        availableAgainAt: null,
        disabledAt: state.disabledAt,
        disabledBy: state.disabledBy,
        enabledAt: event.data.enabledAt,
        // Legacy ruling: events recorded before this field existed carry no
        // `enabledBy` payload key, so they read back as `"seller"` -- every
        // enable before an automated sweep existed was a seller action.
        enabledBy: event.data.enabledBy ?? "seller",
        pendingAwayWindow: state.pendingAwayWindow,
      };
    case "marketplace.seller-listing-availability.offers-disabled":
      return {
        ...state,
        accountId: event.data.accountId,
        offers: {
          ...state.offers,
          status: "unavailable",
          disabledReasonCategory: event.data.reasonCategory,
          availableAgainOn: event.data.availableAgainOn,
          availableAgainAt: event.data.availableAgainAt,
          disabledAt: event.data.disabledAt,
          disabledBy: event.data.disabledBy,
        },
        pendingAwayWindow: null,
      };
    case "marketplace.seller-listing-availability.offers-enabled":
      return {
        ...state,
        accountId: event.data.accountId,
        offers: { ...initialAvailabilityDetails, enabledAt: event.data.enabledAt, enabledBy: event.data.enabledBy },
      };
    case "marketplace.seller-listing-availability.away-window-scheduled":
      return {
        ...state,
        pendingAwayWindow: {
          startsAt: event.data.startsAt,
          endsAt: event.data.endsAt,
          reasonCategory: event.data.reasonCategory,
          ...(event.data.scope === undefined ? {} : { scope: event.data.scope }),
        },
      };
    case "marketplace.seller-listing-availability.away-window-cancelled":
      return {
        ...state,
        pendingAwayWindow: null,
      };
    case "marketplace.seller-listing-availability.commitment-checked":
      return state;
    default:
      return assertNever(event);
  }
};

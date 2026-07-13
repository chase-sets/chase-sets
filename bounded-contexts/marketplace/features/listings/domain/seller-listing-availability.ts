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
}>;

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

export const initialSellerListingAvailabilityState: SellerListingAvailabilityState = {
  accountId: null,
  status: "available",
  disabledReasonCategory: null,
  availableAgainOn: null,
  availableAgainAt: null,
  disabledAt: null,
  disabledBy: null,
  enabledAt: null,
  enabledBy: null,
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

export type SellerListingAvailabilityAwayWindowScheduledEvent = DomainEvent<
  "marketplace.seller-listing-availability.away-window-scheduled",
  {
    accountId: string;
    startsAt: string;
    endsAt: string | null;
    reasonCategory: SellerListingAvailabilityReasonCategory;
    scheduledAt: string;
  }
>;

export type SellerListingAvailabilityAwayWindowCancelledEvent = DomainEvent<
  "marketplace.seller-listing-availability.away-window-cancelled",
  {
    accountId: string;
    cancelledAt: string;
  }
>;

export type SellerListingAvailabilityEvent =
  | SellerListingAvailabilityDisabledEvent
  | SellerListingAvailabilityEnabledEvent
  | SellerListingAvailabilityAwayWindowScheduledEvent
  | SellerListingAvailabilityAwayWindowCancelledEvent;

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

function normalizeReasonCategory(value: SellerListingAvailabilityReasonCategory | null) {
  return value;
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

      const disabledEvent: SellerListingAvailabilityDisabledEvent = {
        type: "marketplace.seller-listing-availability.disabled",
        data: {
          accountId,
          reasonCategory,
          availableAgainOn,
          availableAgainAt,
          disabledAt,
          disabledBy,
        },
      };

      // A manual disable while a window is pending pre-empts it: the seller
      // went away right now by their own action, so the future-dated window
      // is cancelled, not fulfilled -- emit an explicit cancellation fact.
      // A scheduled disable (the window-start sweep consuming its own due
      // window) needs no separate cancellation event: the evolver clears
      // the pending window as part of applying the disabled fact itself.
      if (disabledBy === "seller" && state.pendingAwayWindow !== null) {
        return [
          disabledEvent,
          {
            type: "marketplace.seller-listing-availability.away-window-cancelled",
            data: { accountId, cancelledAt: disabledAt },
          },
        ];
      }

      return [disabledEvent];
    }
    case "EnableSellerListingAvailability": {
      const accountId = normalizeAccountId(command.accountId);
      const enabledAt = command.enabledAt.trim();
      assert(enabledAt.length > 0, "Enabled timestamp is required.");

      if (state.status === "available") {
        return [];
      }

      // Compare-and-swap for a scheduled (auto-resume sweep) enable: when the
      // caller supplies the Resume Instant it observed as due, a mismatch
      // against the CURRENT aggregate means the seller acted between the
      // sweep's read and this command -- no-op rather than clobber that
      // action. Undefined skips the check entirely (unconditional enable).
      //
      // `dueBy` crosses a serialization boundary -- the sweep reads it from
      // the read model as a Postgres timestamptz rendered to text
      // ("2026-07-16 18:53:59.008+00"), while `state.availableAgainAt` is the
      // canonical ISO instant the disable normalized. Compare by instant, not
      // by byte-identical string, so the same moment expressed in either form
      // matches; otherwise every scheduled restore would false-negative as a
      // lost race.
      if (command.dueBy !== undefined && normalizeAvailableAgainAt(command.dueBy) !== state.availableAgainAt) {
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
    case "marketplace.seller-listing-availability.away-window-scheduled":
      return {
        ...state,
        pendingAwayWindow: {
          startsAt: event.data.startsAt,
          endsAt: event.data.endsAt,
          reasonCategory: event.data.reasonCategory,
        },
      };
    case "marketplace.seller-listing-availability.away-window-cancelled":
      return {
        ...state,
        pendingAwayWindow: null,
      };
    default:
      return assertNever(event);
  }
};

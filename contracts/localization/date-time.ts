export type DateDisplayPreset = "short" | "medium" | "long";
export type DateTimeDisplayPreset = "short" | "medium";

export type FormatDateOptions = Readonly<{
  locale?: string;
  /** IANA time zone identifier. Defaults to "UTC" -- the explicit policy for every
   * consumer surface, since timestamps are stored/queried as UTC and a bare browser-
   * or server-local zone would render differently per environment (and mismatch
   * between SSR and hydration). */
  timeZone?: string;
  /** "short": month + day (no year). "medium" (default): month + day + year.
   * "long": full month name + day + year, for editorial/public-facing copy. */
  preset?: DateDisplayPreset;
  /** Set false to omit the day-of-month, for month/year-only display (e.g. "member
   * since January 2026"). Defaults to true. */
  includeDay?: boolean;
  /** Presentation-only fallback for invalid values. When omitted, the historic
   * raw invalid-value behavior is retained for unchanged callers. */
  fallback?: string;
}>;

export type FormatDateTimeOptions = Readonly<{
  locale?: string;
  /** IANA time zone identifier. Defaults to "UTC" (see FormatDateOptions.timeZone). */
  timeZone?: string;
  /** "medium" (default): month + day + year + time. "short": month + day + time,
   * no year (for surfaces where the year is redundant, e.g. recent-activity feeds). */
  preset?: DateTimeDisplayPreset;
  /** Presentation-only fallback for invalid values. When omitted, the historic
   * raw invalid-value behavior is retained for unchanged callers. */
  fallback?: string;
}>;

const DEFAULT_DATE_LOCALE = "en";

const DATE_PRESET_MONTH: Record<DateDisplayPreset, Intl.DateTimeFormatOptions["month"]> = {
  short: "short",
  medium: "short",
  long: "long",
};

const DATE_PRESET_INCLUDES_YEAR: Record<DateDisplayPreset, boolean> = {
  short: false,
  medium: true,
  long: true,
};

// Timestamps in this repo are ISO-parseable strings (event-store canonical
// IsoUtcTimestamp values, and timestamptz::text query-boundary casts, which
// render as e.g. "2026-02-23 21:26:00.123456+00" -- not the strict "Z"-suffixed
// form the IsoUtcTimestamp primitive validates, but reliably parsed by the
// platform's JS runtime). Unlike formatMoney's primitive-validated cents
// round-trip, there is no precision hazard here, so parsing goes through the
// native Date constructor with an explicit NaN guard, matching every one of the
// formatters this consolidates. Malformed input falls back to the raw string,
// matching formatMoney's unparsable-input contract.
function parseDisplayDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats an ISO-parseable timestamp string as a locale-aware, date-only display
 * string (for example "Jan 5, 2026"). This is the single canonical date display
 * helper for `@chase-sets/localization` (it owns locale), replacing the repeated
 * local `formatDate`/`formatTimestamp`/`Intl.DateTimeFormat` definitions across
 * consumer UI.
 *
 * Falls back to the raw input string for unparsable values, matching the
 * historical degraded-display behavior across consumer UI (and `formatMoney`'s
 * unparsable-input contract).
 */
export function formatDate(value: string, options: FormatDateOptions = {}): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return options.fallback ?? value;
  }

  const preset = options.preset ?? "medium";
  const includeDay = options.includeDay ?? true;

  const intlOptions: Intl.DateTimeFormatOptions = {
    timeZone: options.timeZone ?? "UTC",
    month: DATE_PRESET_MONTH[preset],
    ...(includeDay ? { day: "numeric" } : {}),
    ...(DATE_PRESET_INCLUDES_YEAR[preset] ? { year: "numeric" } : {}),
  };

  return new Intl.DateTimeFormat(options.locale ?? DEFAULT_DATE_LOCALE, intlOptions).format(date);
}

/**
 * Formats an ISO-parseable timestamp string as a locale-aware date-and-time
 * display string (for example "Jan 5, 2026, 3:45 PM UTC"). This is the single
 * canonical date-time display helper for `@chase-sets/localization`, replacing
 * the repeated local `formatDateTime`/`formatTimestamp`/raw `.toLocaleString()`
 * call sites across consumer UI -- several of which rendered in the browser's
 * local time zone and locale, diverging by environment and mismatching between
 * server render and client hydration. The explicit "UTC" time-zone default (and
 * literal "UTC" suffix, when the resolved zone is UTC) makes the zone policy
 * unambiguous instead of implicit in the runtime environment.
 *
 * Falls back to the raw input string for unparsable values, matching
 * `formatDate` and `formatMoney`'s unparsable-input contract.
 */
export function formatDateTime(value: string, options: FormatDateTimeOptions = {}): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return options.fallback ?? value;
  }

  const timeZone = options.timeZone ?? "UTC";
  const preset = options.preset ?? "medium";

  const intlOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(preset === "medium" ? { year: "numeric" } : {}),
  };

  const formatted = new Intl.DateTimeFormat(options.locale ?? DEFAULT_DATE_LOCALE, intlOptions).format(date);
  return timeZone === "UTC" ? `${formatted} UTC` : formatted;
}

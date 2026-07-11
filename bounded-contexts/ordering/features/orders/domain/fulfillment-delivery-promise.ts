export type FulfillmentDeliveryPromiseAddress = Readonly<{
  city?: string | null;
  state?: string | null;
  country?: string | null;
}>;

export type FulfillmentDeliveryPromiseInput = Readonly<{
  shippingOption: "standard" | "expedited" | "priority" | string;
  packageCount: number;
  serviceLevels: readonly string[];
  shipFrom: FulfillmentDeliveryPromiseAddress;
  shipTo?: FulfillmentDeliveryPromiseAddress | null;
  now?: Date | string;
  cutoffTimeLocal?: string;
  shipFromTimeZone?: string | null;
  holidayDates?: readonly string[] | null;
  /**
   * True when the order carries an authenticity-check plan (m109):
   * the package routes seller -> facility -> buyer, so the promise window
   * extends by the facility's inspection allowance on top of the normal
   * transit window.
   */
  authenticityCheckSelected?: boolean;
}>;

export type FulfillmentDeliveryPromise = Readonly<{
  earliestDate: string;
  latestDate: string;
  minimumTransitDays: number;
  maximumTransitDays: number;
  handlingDays: number;
  packageCount: number;
  shipFromRegion: string;
  serviceLevel: string;
  promiseOwner: "fulfillment";
  promiseSource: "fulfillment-promise-policy";
  promiseConfidence: "estimated";
  cutoffTimeLocal: string;
  packingStartDate: string;
  carrierHandoffDate: string;
  basis: string;
}>;

const REMOTE_US_REGIONS = new Set(["AK", "HI", "PR", "VI", "GU", "MP", "AS"]);
const EASTERN_STATES = new Set([
  "CT",
  "DE",
  "FL",
  "GA",
  "MA",
  "MD",
  "ME",
  "MI",
  "NC",
  "NH",
  "NJ",
  "NY",
  "OH",
  "PA",
  "RI",
  "SC",
  "VA",
  "VT",
  "WV",
]);
const MOUNTAIN_STATES = new Set(["AZ", "CO", "ID", "MT", "NM", "UT", "WY"]);
const PACIFIC_STATES = new Set(["CA", "NV", "OR", "WA"]);

function addCalendarDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateLabel(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isBusinessDay(date: Date, holidays: ReadonlySet<string>) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(dateLabel(date));
}

function addBusinessDays(date: Date, days: number, holidays: ReadonlySet<string>) {
  let remaining = days;
  let current = new Date(date);
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current, holidays)) {
      remaining -= 1;
    }
  }
  return current;
}

function nextBusinessDay(date: Date, holidays: ReadonlySet<string>) {
  let current = new Date(date);
  while (!isBusinessDay(current, holidays)) {
    current = addCalendarDays(current, 1);
  }
  return current;
}

function parseCutoffMinutes(cutoffTimeLocal: string) {
  const [hour, minute] = cutoffTimeLocal.split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute ?? 0);
  return (Number.isFinite(parsedHour) ? parsedHour : 16) * 60 + (Number.isFinite(parsedMinute) ? parsedMinute : 0);
}

function timeZoneForAddress(address: FulfillmentDeliveryPromiseAddress) {
  const country = String(address.country ?? "")
    .trim()
    .toUpperCase();
  const state = String(address.state ?? "")
    .trim()
    .toUpperCase();

  if (country !== "US") {
    return "UTC";
  }
  if (state === "AK") {
    return "America/Anchorage";
  }
  if (state === "HI") {
    return "Pacific/Honolulu";
  }
  if (PACIFIC_STATES.has(state)) {
    return "America/Los_Angeles";
  }
  if (MOUNTAIN_STATES.has(state)) {
    return "America/Denver";
  }
  if (EASTERN_STATES.has(state)) {
    return "America/New_York";
  }

  return "America/Chicago";
}

function localDateParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function dateFromLocalParts(parts: ReturnType<typeof localDateParts>) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function packingStartDate(now: Date, cutoffTimeLocal: string, timeZone: string, holidays: ReadonlySet<string>) {
  const parts = localDateParts(now, timeZone);
  const localDate = dateFromLocalParts(parts);
  if (!isBusinessDay(localDate, holidays)) {
    return nextBusinessDay(localDate, holidays);
  }

  const localMinutes = parts.hour * 60 + parts.minute;
  return localMinutes < parseCutoffMinutes(cutoffTimeLocal)
    ? localDate
    : nextBusinessDay(addCalendarDays(localDate, 1), holidays);
}

function region(address: FulfillmentDeliveryPromiseAddress | null | undefined) {
  return [address?.city, address?.state].filter((part) => String(part ?? "").trim().length > 0).join(", ");
}

function destinationRegion(address: FulfillmentDeliveryPromiseAddress | null | undefined) {
  const cityState = region(address);
  return cityState || String(address?.country ?? "").trim() || "destination";
}

/**
 * The authenticity-check facility's inspection allowance (m109):
 * added on top of the normal transit window because the package makes two
 * legs (seller -> facility -> buyer) with a check-in and inspection step
 * between them, rather than shipping directly to the buyer.
 */
const AUTHENTICITY_CHECK_INSPECTION_ALLOWANCE = { earliestDays: 2, latestDays: 4 } as const;

function transitWindow(input: FulfillmentDeliveryPromiseInput) {
  const base =
    input.shippingOption === "priority"
      ? { earliestDays: 1, latestDays: 3 }
      : input.shippingOption === "expedited"
        ? { earliestDays: 2, latestDays: 4 }
        : { earliestDays: 4, latestDays: 7 };
  const originCountry = String(input.shipFrom.country ?? "")
    .trim()
    .toUpperCase();
  const destinationCountry = String(input.shipTo?.country ?? originCountry)
    .trim()
    .toUpperCase();
  const originState = String(input.shipFrom.state ?? "")
    .trim()
    .toUpperCase();
  const destinationState = String(input.shipTo?.state ?? "")
    .trim()
    .toUpperCase();

  const withAuthenticityCheck = (window: Readonly<{ earliestDays: number; latestDays: number; basis: string }>) =>
    input.authenticityCheckSelected
      ? {
          earliestDays: window.earliestDays + AUTHENTICITY_CHECK_INSPECTION_ALLOWANCE.earliestDays,
          latestDays: window.latestDays + AUTHENTICITY_CHECK_INSPECTION_ALLOWANCE.latestDays,
          basis: `${window.basis}, authenticity check`,
        }
      : window;

  if (originCountry && destinationCountry && originCountry !== destinationCountry) {
    return withAuthenticityCheck({
      earliestDays: base.earliestDays + 2,
      latestDays: base.latestDays + 4,
      basis: "cross-border",
    });
  }

  if (REMOTE_US_REGIONS.has(destinationState)) {
    return withAuthenticityCheck({
      earliestDays: base.earliestDays + 2,
      latestDays: base.latestDays + 4,
      basis: "remote-region",
    });
  }

  if (originState && destinationState && originState === destinationState) {
    return withAuthenticityCheck({
      earliestDays: base.earliestDays,
      latestDays: Math.max(base.earliestDays, base.latestDays - 1),
      basis: "same-state",
    });
  }

  return withAuthenticityCheck({ ...base, basis: "domestic" });
}

export function createFulfillmentDeliveryPromise(input: FulfillmentDeliveryPromiseInput): FulfillmentDeliveryPromise {
  const cutoffTimeLocal = input.cutoffTimeLocal ?? "16:00";
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const shipFromTimeZone = input.shipFromTimeZone?.trim() || timeZoneForAddress(input.shipFrom);
  const holidays = new Set((input.holidayDates ?? []).map((date) => date.trim()).filter(Boolean));
  const window = transitWindow(input);
  const packageCount = Math.max(1, input.packageCount);
  const handlingDays = packageCount > 1 ? 2 : 1;
  const packingStart = packingStartDate(now, cutoffTimeLocal, shipFromTimeZone, holidays);
  const carrierHandoff = addBusinessDays(packingStart, handlingDays, holidays);
  const serviceLevels = [...new Set(input.serviceLevels.map((level) => level.replace(/-/g, " ")).filter(Boolean))];
  const serviceLevel = serviceLevels.length > 0 ? serviceLevels.join(", ") : `${input.shippingOption} shipping`;
  const shipFromRegion = region(input.shipFrom) || String(input.shipFrom.country ?? "").trim() || "origin";
  const shipToRegion = destinationRegion(input.shipTo);
  const cutoffBasis =
    dateLabel(packingStart) === dateLabel(dateFromLocalParts(localDateParts(now, shipFromTimeZone)))
      ? "before cutoff"
      : "after cutoff/weekend/holiday handoff";

  return {
    earliestDate: dateLabel(addBusinessDays(carrierHandoff, window.earliestDays, holidays)),
    latestDate: dateLabel(addBusinessDays(carrierHandoff, window.latestDays, holidays)),
    minimumTransitDays: window.earliestDays,
    maximumTransitDays: window.latestDays,
    handlingDays,
    packageCount,
    shipFromRegion,
    serviceLevel,
    promiseOwner: "fulfillment",
    promiseSource: "fulfillment-promise-policy",
    promiseConfidence: "estimated",
    cutoffTimeLocal,
    packingStartDate: dateLabel(packingStart),
    carrierHandoffDate: dateLabel(carrierHandoff),
    basis: `${packageCount} package${packageCount === 1 ? "" : "s"} from ${shipFromRegion} to ${shipToRegion}; fulfillment cutoff ${cutoffTimeLocal} ${shipFromTimeZone}; ${handlingDays} seller handling day${handlingDays === 1 ? "" : "s"} ${cutoffBasis} plus ${window.earliestDays}-${window.latestDays} business transit days (${window.basis}).`,
  };
}

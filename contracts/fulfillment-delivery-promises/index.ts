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

function addCalendarDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function isBusinessDay(date: Date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function addBusinessDays(date: Date, days: number) {
  let remaining = days;
  let current = new Date(date);
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current)) {
      remaining -= 1;
    }
  }
  return current;
}

function nextBusinessDay(date: Date) {
  let current = new Date(date);
  while (!isBusinessDay(current)) {
    current = addCalendarDays(current, 1);
  }
  return current;
}

function parseCutoffHour(cutoffTimeLocal: string) {
  const [hour] = cutoffTimeLocal.split(":");
  const parsed = Number(hour);
  return Number.isFinite(parsed) ? parsed : 16;
}

function packingStartDate(now: Date, cutoffTimeLocal: string) {
  if (!isBusinessDay(now)) {
    return nextBusinessDay(now);
  }

  return now.getUTCHours() < parseCutoffHour(cutoffTimeLocal) ? now : nextBusinessDay(addCalendarDays(now, 1));
}

function dateLabel(date: Date) {
  return date.toISOString().slice(0, 10);
}

function region(address: FulfillmentDeliveryPromiseAddress | null | undefined) {
  return [address?.city, address?.state].filter((part) => String(part ?? "").trim().length > 0).join(", ");
}

function destinationRegion(address: FulfillmentDeliveryPromiseAddress | null | undefined) {
  const cityState = region(address);
  return cityState || String(address?.country ?? "").trim() || "destination";
}

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

  if (originCountry && destinationCountry && originCountry !== destinationCountry) {
    return { earliestDays: base.earliestDays + 2, latestDays: base.latestDays + 4, basis: "cross-border" };
  }

  if (REMOTE_US_REGIONS.has(destinationState)) {
    return { earliestDays: base.earliestDays + 2, latestDays: base.latestDays + 4, basis: "remote-region" };
  }

  if (originState && destinationState && originState === destinationState) {
    return {
      earliestDays: base.earliestDays,
      latestDays: Math.max(base.earliestDays, base.latestDays - 1),
      basis: "same-state",
    };
  }

  return { ...base, basis: "domestic" };
}

export function createFulfillmentDeliveryPromise(input: FulfillmentDeliveryPromiseInput): FulfillmentDeliveryPromise {
  const cutoffTimeLocal = input.cutoffTimeLocal ?? "16:00";
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const window = transitWindow(input);
  const packageCount = Math.max(1, input.packageCount);
  const handlingDays = packageCount > 1 ? 2 : 1;
  const packingStart = packingStartDate(now, cutoffTimeLocal);
  const carrierHandoff = addBusinessDays(packingStart, handlingDays);
  const serviceLevels = [...new Set(input.serviceLevels.map((level) => level.replace(/-/g, " ")).filter(Boolean))];
  const serviceLevel = serviceLevels.length > 0 ? serviceLevels.join(", ") : `${input.shippingOption} shipping`;
  const shipFromRegion = region(input.shipFrom) || String(input.shipFrom.country ?? "").trim() || "origin";
  const shipToRegion = destinationRegion(input.shipTo);
  const cutoffBasis = dateLabel(packingStart) === dateLabel(now) ? "before cutoff" : "after cutoff/weekend handoff";

  return {
    earliestDate: dateLabel(addBusinessDays(carrierHandoff, window.earliestDays)),
    latestDate: dateLabel(addBusinessDays(carrierHandoff, window.latestDays)),
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
    basis: `${packageCount} package${packageCount === 1 ? "" : "s"} from ${shipFromRegion} to ${shipToRegion}; fulfillment cutoff ${cutoffTimeLocal} local time; ${handlingDays} seller handling day${handlingDays === 1 ? "" : "s"} ${cutoffBasis} plus ${window.earliestDays}-${window.latestDays} business transit days (${window.basis}).`,
  };
}

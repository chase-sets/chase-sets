import type { RepricingPolicyState } from "./domain";
import type { RepricingHaltState } from "./halt";

export type RepricingConfigurationReceipt<State> = Readonly<{
  requestKey: string;
  requestedRevision: number;
}> &
  (
    | Readonly<{ status: "accepted-pending" }>
    | Readonly<{ status: "applied"; installedRevision: number; state: State }>
    | Readonly<{ status: "superseded-by-revision"; replacingRevision: number }>
  );

export type RepricingPolicyReceipt = RepricingConfigurationReceipt<RepricingPolicyState>;
export type RepricingHaltReceipt = RepricingConfigurationReceipt<RepricingHaltState>;

export type RepricingConfigurationStatus<State> = Readonly<{
  installedRevision: number;
  installedState: State | null;
  requestedRevision: number;
  request: RepricingConfigurationReceipt<State> | null;
}>;

export function configurationRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

export function parseRepricingConfigurationStatus<State>(
  value: unknown,
  parseState: (value: unknown) => State,
): RepricingConfigurationStatus<State> {
  if (
    !value ||
    typeof value !== "object" ||
    !("installedRevision" in value) ||
    !("requestedRevision" in value) ||
    !configurationRevision(value.installedRevision) ||
    !configurationRevision(value.requestedRevision) ||
    value.installedRevision > value.requestedRevision ||
    !("request" in value)
  )
    throw new Error("Invalid Pricing configuration status.");
  if (!("installedState" in value)) throw new Error("Missing installed Pricing configuration value.");
  const installedState = value.installedState === null ? null : parseState(value.installedState);
  const request = value.request === null ? null : parseRepricingConfigurationReceipt(value.request, parseState);
  if (
    (!request && value.installedRevision !== value.requestedRevision) ||
    (request &&
      (request.requestedRevision !== value.requestedRevision ||
        request.status === "superseded-by-revision" ||
        (request.status === "applied" && request.installedRevision !== value.installedRevision) ||
        (request.status === "accepted-pending" && request.requestedRevision <= value.installedRevision)))
  )
    throw new Error("Invalid Pricing configuration status binding.");
  return {
    installedRevision: value.installedRevision,
    installedState,
    requestedRevision: value.requestedRevision,
    request,
  };
}

export function parseRepricingConfigurationReceipt<State>(
  value: unknown,
  parseState: (value: unknown) => State,
): RepricingConfigurationReceipt<State> {
  if (!value || typeof value !== "object" || !("requestKey" in value) || !("requestedRevision" in value))
    throw new Error("Invalid Pricing configuration receipt.");
  const { requestKey, requestedRevision } = value;
  if (
    typeof requestKey !== "string" ||
    !requestKey.length ||
    requestKey.length > 200 ||
    !configurationRevision(requestedRevision) ||
    requestedRevision === 0 ||
    !("status" in value)
  )
    throw new Error("Invalid Pricing configuration receipt.");
  const base = { requestKey, requestedRevision };
  if (value.status === "accepted-pending") {
    if ("state" in value || "installedRevision" in value || "replacingRevision" in value)
      throw new Error("Pending Pricing configuration is not installed.");
    return { ...base, status: value.status };
  }
  if (
    value.status === "superseded-by-revision" &&
    "replacingRevision" in value &&
    configurationRevision(value.replacingRevision) &&
    value.replacingRevision > requestedRevision &&
    !("state" in value) &&
    !("installedRevision" in value)
  )
    return { ...base, status: value.status, replacingRevision: value.replacingRevision };
  if (
    value.status === "applied" &&
    "installedRevision" in value &&
    value.installedRevision === requestedRevision &&
    "state" in value &&
    !("replacingRevision" in value)
  )
    return { ...base, status: value.status, installedRevision: requestedRevision, state: parseState(value.state) };
  throw new Error("Invalid Pricing configuration receipt.");
}

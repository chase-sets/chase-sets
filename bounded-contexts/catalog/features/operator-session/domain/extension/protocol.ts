import {
  parseTcgplayerMarketObservationRequest,
  type TcgplayerMarketObservationRequest,
} from "@chase-sets/tcgplayer-market-observations";

export const operatorEnvironments = ["staging", "production"] as const;
export const operatorExtensionId = "ghemdloifdkoadnapmigabiekchlholm";
export type OperatorEnvironment = (typeof operatorEnvironments)[number];
export const operatorOrigins = {
  staging: "https://admin.staging.chasesets.com",
  production: "https://admin.chasesets.com",
} as const;
export const operatorStates = [
  "unpaired",
  "idle",
  "pushing",
  "retrying",
  "error",
  "re-pair-required",
  "upgrade-required",
] as const;
export type OperatorState = (typeof operatorStates)[number];
export const operatorOutcomes = [
  "stored",
  "unchanged",
  "stale-revision",
  "grant-invalid",
  "rate-limited",
  "unavailable",
  "refused",
  "invalid-response",
] as const;
export type OperatorOutcome = (typeof operatorOutcomes)[number];
export type OperatorStatus = {
  paired: boolean;
  state: OperatorState;
  lastOutcome: OperatorOutcome | null;
  lastPushedAt: string | null;
  serverRevision: number;
};
export type OperatorCommand =
  | { action: "pair"; environment: OperatorEnvironment; grant: string }
  | { action: "status" | "unpair" | "recover" | "poll-now"; environment: OperatorEnvironment };

type ObservationRequestIdentity = Readonly<{ requestId: string; expiresAt: string }>;
export type CatalogObservationRequest = ObservationRequestIdentity &
  (
    | Readonly<{ kind: "set-names"; productLineId: number }>
    | Readonly<{ kind: "sealed-products"; productLineId: number; setNameId: number; searchName: string }>
  );
export type OperatorObservationRequest =
  | CatalogObservationRequest
  | (ObservationRequestIdentity &
      Readonly<{ kind: "market-observations"; marketRequest: TcgplayerMarketObservationRequest }>);
export const observationPollVersion = "2";

const observationId = /^[A-Za-z0-9_-]{1,64}$/;
const providerId = (value: unknown): value is number => safeInteger(value) && value > 0 && value <= 2147483647;
const requestIdentity = ["kind", "requestId", "expiresAt"];

export function isCatalogObservationRequest(value: unknown): value is CatalogObservationRequest {
  return (
    ((closed(value, [...requestIdentity, "productLineId"]) && value.kind === "set-names") ||
      (closed(value, [...requestIdentity, "productLineId", "setNameId", "searchName"]) &&
        value.kind === "sealed-products" &&
        providerId(value.setNameId) &&
        typeof value.searchName === "string" &&
        value.searchName.length <= 256 &&
        value.searchName.trim().length > 0 &&
        !/[\x00-\x1f\x7f]|:\/\//.test(value.searchName))) &&
    typeof value.requestId === "string" &&
    observationId.test(value.requestId) &&
    isInstant(value.expiresAt) &&
    providerId(value.productLineId)
  );
}

export function parseObservationPoll(value: unknown): OperatorObservationRequest | null {
  if (closed(value, ["contractVersion", "request"]) && value.contractVersion === 2) {
    const request = value.request;
    if (request === null || isCatalogObservationRequest(request)) return request;
    if (
      closed(request, [...requestIdentity, "marketRequest"]) &&
      request.kind === "market-observations" &&
      isInstant(request.expiresAt)
    ) {
      const marketRequest = parseTcgplayerMarketObservationRequest(request.marketRequest);
      if (request.requestId === marketRequest.requestId)
        return { kind: request.kind, requestId: request.requestId, expiresAt: request.expiresAt, marketRequest };
    }
  }
  throw new Error("invalid-observation-poll");
}

export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isEnvironment(value: unknown): value is OperatorEnvironment {
  return value === "staging" || value === "production";
}
export function isGrant(value: unknown): value is string {
  // 32 bytes, canonical base64url (the last two pad bits must be zero).
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}
export function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function isCommand(value: unknown): value is OperatorCommand {
  if (typeof value !== "object" || value === null || !("action" in value)) return false;
  if (value.action === "pair")
    return (
      closed(value, ["action", "environment", "grant"]) &&
      "environment" in value &&
      "grant" in value &&
      isEnvironment(value.environment) &&
      isGrant(value.grant)
    );
  return (
    closed(value, ["action", "environment"]) &&
    "environment" in value &&
    isEnvironment(value.environment) &&
    (value.action === "status" ||
      value.action === "unpair" ||
      value.action === "recover" ||
      value.action === "poll-now")
  );
}
export function isStatus(value: unknown): value is OperatorStatus {
  return (
    closed(value, ["paired", "state", "lastOutcome", "lastPushedAt", "serverRevision"]) &&
    typeof value.paired === "boolean" &&
    operatorStates.some((state) => state === value.state) &&
    (value.lastOutcome === null || operatorOutcomes.some((outcome) => outcome === value.lastOutcome)) &&
    (value.lastPushedAt === null || isInstant(value.lastPushedAt)) &&
    safeInteger(value.serverRevision) &&
    true
  );
}

export const operatorEnvironments = ["staging", "production"] as const;
export type OperatorEnvironment = (typeof operatorEnvironments)[number];
export const operatorOrigins = {
  staging: "https://admin.staging.chasesets.com",
  production: "https://admin.chasesets.com",
} as const;
export const operatorCookieUrl = "https://store.tcgplayer.com/admin/pricing";
export const operatorCookieName = "TCGAuthTicket_Production";
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
  "cookie-absent",
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
  cookiePresent: boolean;
  browserExpiresAt: string | null;
};
export type OperatorCommand =
  | { action: "pair"; environment: OperatorEnvironment; grant: string }
  | { action: "status" | "unpair" | "recover"; environment: OperatorEnvironment };

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
    (value.action === "status" || value.action === "unpair" || value.action === "recover")
  );
}
export function isStatus(value: unknown): value is OperatorStatus {
  return (
    closed(value, [
      "paired",
      "state",
      "lastOutcome",
      "lastPushedAt",
      "serverRevision",
      "cookiePresent",
      "browserExpiresAt",
    ]) &&
    typeof value.paired === "boolean" &&
    operatorStates.some((state) => state === value.state) &&
    (value.lastOutcome === null || operatorOutcomes.some((outcome) => outcome === value.lastOutcome)) &&
    (value.lastPushedAt === null || isInstant(value.lastPushedAt)) &&
    safeInteger(value.serverRevision) &&
    typeof value.cookiePresent === "boolean" &&
    (value.browserExpiresAt === null || isInstant(value.browserExpiresAt))
  );
}

export type OperatorCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  storeId: string;
  expirationDate?: number;
  partitionKey?: unknown;
};
export function isOperatorCookie(cookie: OperatorCookie): boolean {
  return (
    cookie.name === operatorCookieName &&
    (cookie.domain === "store.tcgplayer.com" ||
      cookie.domain === ".store.tcgplayer.com" ||
      cookie.domain === ".tcgplayer.com") &&
    cookie.storeId === "0" &&
    cookie.partitionKey === undefined
  );
}
export function cookieExpiry(cookie: OperatorCookie): string | null {
  const instant = cookie.expirationDate === undefined ? NaN : cookie.expirationDate * 1000;
  return Number.isFinite(instant) && instant >= 0 && instant <= 253402300799999
    ? new Date(instant).toISOString()
    : null;
}

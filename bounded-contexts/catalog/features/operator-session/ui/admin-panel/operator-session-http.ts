import { validateOperatorSessionInstant, validateOperatorSessionRevision } from "../../domain/value";

// Browser client for the three Admin operator-session routes
// (api/route.ts operatorSessionAdminRoutes). Every response is validated
// against the closed api/grants.ts shapes before the panel sees it; failures
// collapse to a bounded code, so response bodies and thrown errors never reach
// the UI.
export const operatorSessionProviderKey = "tcgplayer";
const adminPath = "/api/catalog/operator-session";

export type OperatorSessionGrantMetadata = Readonly<{
  active: boolean;
  createdAt: string;
  idleExpiresAt: string;
  lastUsedAt: string;
}>;

export type OperatorSessionMetadata = Readonly<{
  revision: number;
  storedAt: string | null;
  browserExpiresAt: string | null;
  custodyAvailable: boolean;
  grant: OperatorSessionGrantMetadata | null;
}>;

export type OperatorSessionMintedGrant = Readonly<{ grant: string; idleExpiresAt: string }>;

export type OperatorSessionDisconnectOutcome = Readonly<{
  outcome: "cleared" | "unchanged" | "stale-revision";
  revision: number;
}>;

export type OperatorSessionFailure =
  | "step-up-required"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "custody-unavailable"
  | "revision-exhausted"
  | "unknown";

export type OperatorSessionResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: OperatorSessionFailure }>;

export async function readOperatorSessionMetadata(): Promise<OperatorSessionResult<OperatorSessionMetadata>> {
  const response = await send("GET", adminPath);
  if (response?.status !== 200) return failed(response);
  return validated(parseMetadata(response.body));
}

export async function mintOperatorSessionGrant(): Promise<OperatorSessionResult<OperatorSessionMintedGrant>> {
  const response = await send("POST", `${adminPath}/grant`);
  if (response?.status !== 200) return failed(response);
  return validated(parseMintedGrant(response.body));
}

export async function disconnectOperatorSession(): Promise<OperatorSessionResult<OperatorSessionDisconnectOutcome>> {
  const response = await send("DELETE", adminPath);
  if (response?.status === 200) return validated(parseDisconnectOutcome(response.body, ["cleared", "unchanged"]));
  if (response?.status === 409) return validated(parseDisconnectOutcome(response.body, ["stale-revision"]));
  return failed(response);
}

type RawResponse = Readonly<{ status: number; body: unknown }>;

async function send(method: "GET" | "POST" | "DELETE", path: string): Promise<RawResponse | null> {
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { status: response.status, body };
  } catch {
    return null;
  }
}

// Step-up is the flat 400 {code:"step_up_required"} the slice middleware
// returns (api/route.ts). The payout-style nested {error:{code}} envelope is a
// different contract and is deliberately not recognised here. Every 403 shape
// (host authorization_forbidden or the slice's flat forbidden) is forbidden.
function failed(response: RawResponse | null): Readonly<{ ok: false; failure: OperatorSessionFailure }> {
  return { ok: false, failure: classifyFailure(response) };
}

function classifyFailure(response: RawResponse | null): OperatorSessionFailure {
  if (!response) return "unknown";
  const code = isRecord(response.body) ? response.body.code : undefined;
  if (response.status === 400 && code === "step_up_required") return "step-up-required";
  if (response.status === 401) return "unauthenticated";
  if (response.status === 403) return "forbidden";
  if (response.status === 429) return "rate-limited";
  if (response.status === 503 && code === "custody-unavailable") return "custody-unavailable";
  if (response.status === 503 && code === "revision-exhausted") return "revision-exhausted";
  return "unknown";
}

function validated<T>(value: T | null): OperatorSessionResult<T> {
  return value === null ? { ok: false, failure: "unknown" } : { ok: true, value };
}

function parseMetadata(body: unknown): OperatorSessionMetadata | null {
  if (!hasExactKeys(body, ["revision", "storedAt", "browserExpiresAt", "custodyAvailable", "grant"])) return null;
  const { revision, storedAt, browserExpiresAt, custodyAvailable, grant } = body;
  if (!isRevision(revision) || typeof custodyAvailable !== "boolean") return null;
  if (!isNullableInstant(storedAt) || !isNullableInstant(browserExpiresAt)) return null;
  // Absent custody is revision 0 with null instants; cleared custody keeps its
  // revision with null instants; only stored custody carries instants.
  if (storedAt === null ? browserExpiresAt !== null : revision === 0) return null;
  const parsedGrant = grant === null ? null : parseGrantMetadata(grant);
  if (grant !== null && parsedGrant === null) return null;
  return { revision, storedAt, browserExpiresAt, custodyAvailable, grant: parsedGrant };
}

function parseGrantMetadata(body: unknown): OperatorSessionGrantMetadata | null {
  if (!hasExactKeys(body, ["active", "createdAt", "idleExpiresAt", "lastUsedAt"])) return null;
  const { active, createdAt, idleExpiresAt, lastUsedAt } = body;
  if (typeof active !== "boolean" || !isInstant(createdAt) || !isInstant(idleExpiresAt) || !isInstant(lastUsedAt))
    return null;
  return { active, createdAt, idleExpiresAt, lastUsedAt };
}

// grants.ts mints randomBytes(32) as base64url: exactly 43 URL-safe characters.
function parseMintedGrant(body: unknown): OperatorSessionMintedGrant | null {
  if (!hasExactKeys(body, ["grant", "idleExpiresAt"])) return null;
  const { grant, idleExpiresAt } = body;
  if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant) || !isInstant(idleExpiresAt)) return null;
  return { grant, idleExpiresAt };
}

function parseDisconnectOutcome(
  body: unknown,
  outcomes: readonly OperatorSessionDisconnectOutcome["outcome"][],
): OperatorSessionDisconnectOutcome | null {
  if (!hasExactKeys(body, ["outcome", "revision"])) return null;
  const { outcome, revision } = body;
  if (!outcomes.includes(outcome as OperatorSessionDisconnectOutcome["outcome"]) || !isRevision(revision)) return null;
  return { outcome: outcome as OperatorSessionDisconnectOutcome["outcome"], revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && passes(() => validateOperatorSessionRevision(value));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && passes(() => validateOperatorSessionInstant(value));
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function passes(validate: () => void): boolean {
  try {
    validate();
    return true;
  } catch {
    return false;
  }
}

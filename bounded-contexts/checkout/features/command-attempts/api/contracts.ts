/**
 * The public Checkout Command Attempt contract, shared by the cart routes, the
 * attempt lookup, and every caller that mints or resolves an attempt.
 *
 * Nothing here imports a server module: the request hash is computed with Web
 * Crypto so a caller and the owner hash the exact same canonical bytes, and the
 * result parser is the same closed validator the owner applies to its own
 * retained history.
 */

/** A deliberate cart submission's opaque attempt id: 22-128 base64url characters. */
export const CHECKOUT_COMMAND_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** The owner-authority MCP idempotency key shape (canonical lowercase UUIDv4), as Inventory uses. */
export const CHECKOUT_MCP_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One cart write carries at most this many line commands; more are refused before any read. */
export const CHECKOUT_CART_ATTEMPT_MAX_COMMANDS = 250;

export const CHECKOUT_CART_ATTEMPT_KINDS = [
  "cart.add-line",
  "cart.add-lines",
  "cart.set-quantity",
  "cart.set-fulfillment",
  "cart.remove-line",
  "cart.update-line",
  "cart.commands",
  "cart.session-cleanup",
] as const;

export type CheckoutCartAttemptKind = (typeof CHECKOUT_CART_ATTEMPT_KINDS)[number];

/** The one kind a Checkout Session entry records (#9994); its result names the Session it opened. */
export const CHECKOUT_ENTRY_ATTEMPT_KIND = "checkout-entry";

/** The target every entry attempt names, so a reused key with any changed source addresses the same stream. */
export const CHECKOUT_ENTRY_ATTEMPT_TARGET = "session";

export type CheckoutCommandAttemptKind = CheckoutCartAttemptKind | typeof CHECKOUT_ENTRY_ATTEMPT_KIND;

/** The target every cart-wide attempt names; line attempts name their cart line id instead. */
export const CHECKOUT_CART_ATTEMPT_CART_TARGET = "cart";

export type CheckoutCartLineCommandName = "add" | "quantity" | "fulfillment" | "remove" | "checkout";

export type CheckoutCartLineOutcome = Readonly<{
  index: number;
  command: CheckoutCartLineCommandName;
  outcome: "succeeded" | "conflict" | "error";
  lineId: string | null;
  status: "added" | "merged" | "quantity-updated" | "fulfillment-updated" | "removed" | "checked-out" | null;
  version: number;
  message: string | null;
}>;

export type CheckoutCommandAttemptOwnerStatus = "not-observed" | "committed" | "conflict" | "failed-safe" | "ambiguous";

export type CheckoutCommandAttemptResult = Readonly<{
  schemaVersion: 1;
  kind: CheckoutCommandAttemptKind;
  fingerprint: string;
  actorBinding: Readonly<{ kind: "account" | "anonymous"; digest: string }>;
  target: string;
  requestHash: string;
  ownerStatus: CheckoutCommandAttemptOwnerStatus;
  reason?: "cart-changed" | "history-incomplete";
  vector?: readonly CheckoutCartLineOutcome[];
  /** The Checkout Session a committed `checkout-entry` attempt opened; never present on a cart attempt. */
  sessionId?: string;
  commitReceipt?: Readonly<{ eventId: string; globalPosition: string }>;
}>;

/** Client-side attempt states (decision 6); a committed vector with conflict/error entries renders `partial`. */
export type CheckoutCommandAttemptState =
  | "editing"
  | "submitting"
  | "confirming"
  | "succeeded"
  | "partial"
  | "failed-safe"
  | "ambiguous";

/** The terminal states one owner answer can resolve a submission to. */
export type CheckoutCommandAttemptResolvedState = Extract<
  CheckoutCommandAttemptState,
  "succeeded" | "partial" | "failed-safe" | "ambiguous"
>;

export function isCheckoutCommandAttemptId(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_COMMAND_ATTEMPT_ID_PATTERN.test(value);
}

export function isCheckoutCartAttemptKind(value: unknown): value is CheckoutCartAttemptKind {
  return typeof value === "string" && (CHECKOUT_CART_ATTEMPT_KINDS as readonly string[]).includes(value);
}

export function isCheckoutCommandAttemptKind(value: unknown): value is CheckoutCommandAttemptKind {
  return value === CHECKOUT_ENTRY_ATTEMPT_KIND || isCheckoutCartAttemptKind(value);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints one new attempt id for one deliberate submission (32 base64url characters, 192 random bits). */
export function mintCheckoutCommandAttemptId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * The canonical request a hash covers: the JSON body exactly as sent, minus the
 * attempt id itself, with object keys sorted. The owner hashes the body it
 * received and the caller hashes the body it sent, so both sides agree without
 * either normalizing the other's fields.
 */
export function canonicalCheckoutCommandAttemptRequest(body: unknown): string {
  const plain = body === undefined ? null : JSON.parse(JSON.stringify(body));
  if (plain && typeof plain === "object" && !Array.isArray(plain)) {
    delete (plain as Record<string, unknown>).attemptId;
  }
  return canonicalJson(plain);
}

export async function computeCheckoutCommandAttemptRequestHash(body: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`checkout-command-attempt-request/v1\n${canonicalCheckoutCommandAttemptRequest(body)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const CHECKOUT_SESSION_ID = /^chk_[0-9A-Za-z_]{1,64}$/;
const LINE_STATUSES = new Set(["added", "merged", "quantity-updated", "fulfillment-updated", "removed", "checked-out"]);
const LINE_COMMANDS = new Set(["add", "quantity", "fulfillment", "remove", "checkout"]);
const LINE_OUTCOMES = new Set(["succeeded", "conflict", "error"]);
const OWNER_STATUSES = new Set(["not-observed", "committed", "conflict", "failed-safe", "ambiguous"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isNullableString(value: unknown, maxLength: number) {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isLineOutcome(value: unknown, index: number): value is CheckoutCartLineOutcome {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["index", "command", "outcome", "lineId", "status", "version", "message"]) &&
    value.index === index &&
    LINE_COMMANDS.has(value.command as string) &&
    LINE_OUTCOMES.has(value.outcome as string) &&
    isNullableString(value.lineId, 128) &&
    (value.status === null || LINE_STATUSES.has(value.status as string)) &&
    (value.outcome === "succeeded") === (value.status !== null) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 0 &&
    isNullableString(value.message, 512)
  );
}

/**
 * Closed, recursive validation of one attempt result. Every nested object is
 * checked for its exact key set, so an extra field anywhere -- a raw id, a
 * cookie, an unknown status -- rejects the whole payload rather than passing
 * through a shallow check.
 */
export function parseCheckoutCommandAttemptResult(value: unknown): CheckoutCommandAttemptResult | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["schemaVersion", "kind", "fingerprint", "actorBinding", "target", "requestHash", "ownerStatus"],
      ["reason", "vector", "sessionId", "commitReceipt"],
    ) ||
    value.schemaVersion !== 1 ||
    !isCheckoutCommandAttemptKind(value.kind) ||
    typeof value.fingerprint !== "string" ||
    !HEX_DIGEST.test(value.fingerprint) ||
    typeof value.target !== "string" ||
    value.target.length === 0 ||
    value.target.length > 128 ||
    typeof value.requestHash !== "string" ||
    !HEX_DIGEST.test(value.requestHash) ||
    !OWNER_STATUSES.has(value.ownerStatus as string)
  ) {
    return null;
  }
  const binding = value.actorBinding;
  if (
    !isRecord(binding) ||
    !hasOnlyKeys(binding, ["kind", "digest"]) ||
    (binding.kind !== "account" && binding.kind !== "anonymous") ||
    typeof binding.digest !== "string" ||
    !HEX_DIGEST.test(binding.digest)
  ) {
    return null;
  }
  if ("reason" in value && value.reason !== "cart-changed" && value.reason !== "history-incomplete") {
    return null;
  }
  if ("vector" in value) {
    const vector = value.vector;
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.length > CHECKOUT_CART_ATTEMPT_MAX_COMMANDS ||
      !vector.every((entry, index) => isLineOutcome(entry, index))
    ) {
      return null;
    }
  }
  if ("commitReceipt" in value) {
    const receipt = value.commitReceipt;
    if (
      !isRecord(receipt) ||
      !hasOnlyKeys(receipt, ["eventId", "globalPosition"]) ||
      typeof receipt.eventId !== "string" ||
      receipt.eventId.length === 0 ||
      receipt.eventId.length > 128 ||
      typeof receipt.globalPosition !== "string" ||
      !/^[0-9]{1,30}$/.test(receipt.globalPosition)
    ) {
      return null;
    }
  }
  const isEntry = value.kind === CHECKOUT_ENTRY_ATTEMPT_KIND;
  if (
    "sessionId" in value &&
    (!isEntry || typeof value.sessionId !== "string" || !CHECKOUT_SESSION_ID.test(value.sessionId))
  ) {
    return null;
  }
  if (isEntry && "vector" in value) {
    return null;
  }
  // A committed cart attempt carries its line vector; a committed entry carries the Session it opened.
  if (value.ownerStatus === "committed" && !(isEntry ? "sessionId" in value : "vector" in value)) {
    return null;
  }
  return value as CheckoutCommandAttemptResult;
}

/**
 * The client state a resolved owner answer renders, per decision 6. A committed
 * vector that applied nothing is failed-safe; one that applied some lines and
 * refused others is partial.
 */
export function checkoutCommandAttemptStateForResult(
  result: CheckoutCommandAttemptResult,
): CheckoutCommandAttemptResolvedState {
  switch (result.ownerStatus) {
    case "committed": {
      if (result.kind === CHECKOUT_ENTRY_ATTEMPT_KIND) return "succeeded";
      const succeeded = result.vector?.filter((line) => line.outcome === "succeeded").length ?? 0;
      return succeeded === (result.vector?.length ?? 0) ? "succeeded" : succeeded === 0 ? "failed-safe" : "partial";
    }
    case "failed-safe":
    case "conflict":
      return "failed-safe";
    case "ambiguous":
    case "not-observed":
      return "ambiguous";
  }
}

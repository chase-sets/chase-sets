import { createHash, randomBytes } from "node:crypto";

export const PUBLIC_REFERRAL_CODE_PREFIX = "wlr_";
export const REFERRAL_LINK_PROVISIONING_ID_PREFIX = "wlp_";
export const PUBLIC_REFERRAL_CODE_BYTES = 24;
export const REFERRAL_LINK_PROVISIONING_ID_BYTES = 16;
export const REFERRAL_LINK_PROVISIONING_SCHEMA_VERSION = "referral-link-provisioning/v1" as const;

/**
 * The one place the reservation stream namespace is spelled. Every writer and
 * every reader derives the canonical identity through
 * {@link publicReferralCodeReservationStreamId}; nothing re-derives the string.
 */
export const PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX = "public-presence.waitlist-referral-code-";

export const publicReferralCodePattern = /^wlr_[A-Za-z0-9_-]{32,}$/;
const provisioningIdPattern = /^wlp_[A-Za-z0-9_-]{22,}$/;
export const waitlistSignupIdPattern = /^wls_[0-9a-z]+$/;
const tupleValuePattern = /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/;
export const lowercaseSha256Pattern = /^[0-9a-f]{64}$/;
const utcMillisecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SecureRandomBytes = (byteLength: number) => Uint8Array;

export type CreatorUtmTuple = Readonly<{
  utm_source: "creator";
  utm_medium: string;
  utm_campaign: string;
}>;

export type ReferralLinkProvisioningRequest = Readonly<{
  signupId: string;
  tuple: CreatorUtmTuple;
}>;

export type ReferralLinkProvisioningPayload = Readonly<{
  provisioningId: string;
  publicReferralCode: string;
  tuple: CreatorUtmTuple;
  referralLink: string;
  issuedAt: string;
}>;

export type ReferralLinkProvisioningReceipt = Readonly<{
  schemaVersion: typeof REFERRAL_LINK_PROVISIONING_SCHEMA_VERSION;
  payload: ReferralLinkProvisioningPayload;
  receiptSha256: string;
}>;

export function generatePublicReferralCode(random: SecureRandomBytes = randomBytes): string {
  return `${PUBLIC_REFERRAL_CODE_PREFIX}${toBase64Url(assertRandomBytes(random(PUBLIC_REFERRAL_CODE_BYTES), PUBLIC_REFERRAL_CODE_BYTES))}`;
}

export function generateReferralLinkProvisioningId(random: SecureRandomBytes = randomBytes): string {
  return `${REFERRAL_LINK_PROVISIONING_ID_PREFIX}${toBase64Url(
    assertRandomBytes(random(REFERRAL_LINK_PROVISIONING_ID_BYTES), REFERRAL_LINK_PROVISIONING_ID_BYTES),
  )}`;
}

export function publicReferralCodeDigest(publicReferralCode: string): string {
  assertPublicReferralCode(publicReferralCode);
  return sha256Hex(publicReferralCode);
}

/**
 * The canonical uniqueness-reservation stream identity for one Public Referral
 * Code: the fixed prefix followed by the lowercase hex SHA-256 digest of the
 * code. No code material appears in the stream name, so a stream listing never
 * discloses a capability.
 */
export function publicReferralCodeReservationStreamId(publicReferralCode: string): string {
  return `${PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX}${publicReferralCodeDigest(publicReferralCode)}`;
}

export function normalizeReferralLinkProvisioningRequest(value: unknown): ReferralLinkProvisioningRequest {
  const body = assertClosedObject(value, ["signupId", "tuple"], "request");
  if (typeof body.signupId !== "string" || !waitlistSignupIdPattern.test(body.signupId)) {
    throw new Error("request.signupId must be a private Waitlist Signup id.");
  }
  const tuple = assertClosedObject(body.tuple, ["utm_source", "utm_medium", "utm_campaign"], "request.tuple");
  if (tuple.utm_source !== "creator") {
    throw new Error('request.tuple.utm_source must equal "creator".');
  }

  return {
    signupId: body.signupId,
    tuple: {
      utm_source: "creator",
      utm_medium: normalizeTupleValue(tuple.utm_medium, "utm_medium"),
      utm_campaign: normalizeTupleValue(tuple.utm_campaign, "utm_campaign"),
    },
  };
}

export function buildReferralLink(publicReferralCode: string, tuple: CreatorUtmTuple): string {
  assertPublicReferralCode(publicReferralCode);
  const url = new URL("https://chasesets.com/");
  url.searchParams.append("ref", publicReferralCode);
  url.searchParams.append("utm_source", tuple.utm_source);
  url.searchParams.append("utm_medium", tuple.utm_medium);
  url.searchParams.append("utm_campaign", tuple.utm_campaign);
  return url.toString();
}

export function createReferralLinkProvisioningReceipt(
  payload: ReferralLinkProvisioningPayload,
): ReferralLinkProvisioningReceipt {
  assertReferralLinkProvisioningPayload(payload);
  return {
    schemaVersion: REFERRAL_LINK_PROVISIONING_SCHEMA_VERSION,
    payload,
    receiptSha256: sha256Jcs(payload),
  };
}

export function assertReferralLinkProvisioningReceipt(value: unknown): ReferralLinkProvisioningReceipt {
  const receipt = assertClosedObject(value, ["schemaVersion", "payload", "receiptSha256"], "receipt");
  if (receipt.schemaVersion !== REFERRAL_LINK_PROVISIONING_SCHEMA_VERSION) {
    throw new Error("Unsupported referral-link provisioning receipt schemaVersion.");
  }
  assertReferralLinkProvisioningPayload(receipt.payload);
  if (typeof receipt.receiptSha256 !== "string" || !lowercaseSha256Pattern.test(receipt.receiptSha256)) {
    throw new Error("receipt.receiptSha256 must be a lowercase SHA-256 digest.");
  }
  if (receipt.receiptSha256 !== sha256Jcs(receipt.payload)) {
    throw new Error("Referral-link provisioning receipt digest does not match its payload.");
  }
  return value as ReferralLinkProvisioningReceipt;
}

export function sha256Jcs(value: unknown): string {
  return sha256Hex(jcsStringify(value));
}

export function jcsStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS values must contain only finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcsStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new Error("JCS values must not contain undefined members.");
        return `${JSON.stringify(key)}:${jcsStringify(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`Unsupported JCS value type: ${typeof value}.`);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertUtcMillisecondInstant(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || !utcMillisecondPattern.test(value)) {
    throw new Error(`${fieldName} must be a UTC millisecond instant.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${fieldName} must be a valid UTC millisecond instant.`);
  }
}

function assertReferralLinkProvisioningPayload(value: unknown): asserts value is ReferralLinkProvisioningPayload {
  const payload = assertClosedObject(
    value,
    ["provisioningId", "publicReferralCode", "tuple", "referralLink", "issuedAt"],
    "receipt.payload",
  );
  if (typeof payload.provisioningId !== "string" || !provisioningIdPattern.test(payload.provisioningId)) {
    throw new Error("receipt.payload.provisioningId is invalid.");
  }
  if (typeof payload.publicReferralCode !== "string")
    throw new Error("receipt.payload.publicReferralCode is required.");
  assertPublicReferralCode(payload.publicReferralCode);
  const normalized = normalizeReferralLinkProvisioningRequest({ signupId: "wls_receipt", tuple: payload.tuple });
  if (
    typeof payload.referralLink !== "string" ||
    payload.referralLink !== buildReferralLink(payload.publicReferralCode, normalized.tuple)
  ) {
    throw new Error("receipt.payload.referralLink does not match the code and tuple.");
  }
  assertUtcMillisecondInstant(payload.issuedAt, "receipt.payload.issuedAt");
}

function assertPublicReferralCode(value: string): void {
  if (!publicReferralCodePattern.test(value)) throw new Error("Public Referral Code is invalid.");
}

function normalizeTupleValue(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`request.tuple.${fieldName} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120 || !tupleValuePattern.test(normalized)) {
    throw new Error(`request.tuple.${fieldName} is invalid.`);
  }
  return normalized;
}

function assertClosedObject(value: unknown, keys: readonly string[], fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} must be an object.`);
  const actualKeys = Object.keys(value as Record<string, unknown>).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${fieldName} must contain exactly: ${keys.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

function assertRandomBytes(value: Uint8Array, expectedLength: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < expectedLength) {
    throw new Error(`Secure random source must return at least ${expectedLength} bytes.`);
  }
  return value;
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

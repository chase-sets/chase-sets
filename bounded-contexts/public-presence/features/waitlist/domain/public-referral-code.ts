import { createHash, randomBytes } from "node:crypto";

export const PUBLIC_REFERRAL_CODE_PREFIX = "wlr_";
export const REFERRAL_LINK_PROVISIONING_ID_PREFIX = "wlp_";
export const PUBLIC_REFERRAL_CODE_BYTES = 24;
export const REFERRAL_LINK_PROVISIONING_ID_BYTES = 16;
export const REFERRAL_LINK_PROVISIONING_SCHEMA_VERSION = "referral-link-provisioning/v1" as const;
export const PUBLIC_REFERRAL_CODE_COVERAGE_SCHEMA_VERSION = "public-referral-code-coverage/v1" as const;

const publicReferralCodePattern = /^wlr_[A-Za-z0-9_-]{32,}$/;
const provisioningIdPattern = /^wlp_[A-Za-z0-9_-]{22,}$/;
const waitlistSignupIdPattern = /^wls_[0-9a-z]+$/;
const tupleValuePattern = /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/;
const lowercaseSha256Pattern = /^[0-9a-f]{64}$/;
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

export type PublicReferralCodeCoverageRefusalCounts = Readonly<{
  missingRecorded: number;
  missingIssued: number;
  missingReservation: number;
  mismatched: number;
  duplicate: number;
  unexpected: number;
}>;

export type PublicReferralCodeCoveragePayload = Readonly<{
  horizonGlobalPosition: string;
  completeSignupCount: number;
  validIssuedCount: number;
  validReservedCount: number;
  refusalCounts: PublicReferralCodeCoverageRefusalCounts;
  cutoverEligible: boolean;
  startedAt: string;
  completedAt: string;
}>;

export type PublicReferralCodeCoverageReceipt = Readonly<{
  schemaVersion: typeof PUBLIC_REFERRAL_CODE_COVERAGE_SCHEMA_VERSION;
  payload: PublicReferralCodeCoveragePayload;
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

export function createPublicReferralCodeCoverageReceipt(
  payload: PublicReferralCodeCoveragePayload,
): PublicReferralCodeCoverageReceipt {
  assertPublicReferralCodeCoveragePayload(payload);
  return {
    schemaVersion: PUBLIC_REFERRAL_CODE_COVERAGE_SCHEMA_VERSION,
    payload,
    receiptSha256: sha256Jcs(payload),
  };
}

export function assertPublicReferralCodeCoverageReceipt(value: unknown): PublicReferralCodeCoverageReceipt {
  const receipt = assertClosedObject(value, ["schemaVersion", "payload", "receiptSha256"], "receipt");
  if (receipt.schemaVersion !== PUBLIC_REFERRAL_CODE_COVERAGE_SCHEMA_VERSION) {
    throw new Error("Unsupported Public Referral Code coverage receipt schemaVersion.");
  }
  assertPublicReferralCodeCoveragePayload(receipt.payload);
  if (typeof receipt.receiptSha256 !== "string" || receipt.receiptSha256 !== sha256Jcs(receipt.payload)) {
    throw new Error("Public Referral Code coverage receipt digest does not match its payload.");
  }
  return value as PublicReferralCodeCoverageReceipt;
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

function assertPublicReferralCodeCoveragePayload(value: unknown): asserts value is PublicReferralCodeCoveragePayload {
  const payload = assertClosedObject(
    value,
    [
      "horizonGlobalPosition",
      "completeSignupCount",
      "validIssuedCount",
      "validReservedCount",
      "refusalCounts",
      "cutoverEligible",
      "startedAt",
      "completedAt",
    ],
    "receipt.payload",
  );
  if (typeof payload.horizonGlobalPosition !== "string" || !/^(0|[1-9]\d*)$/.test(payload.horizonGlobalPosition)) {
    throw new Error("receipt.payload.horizonGlobalPosition is invalid.");
  }
  for (const field of ["completeSignupCount", "validIssuedCount", "validReservedCount"] as const) {
    assertNonNegativeInteger(payload[field], `receipt.payload.${field}`);
  }
  const refusals = assertClosedObject(
    payload.refusalCounts,
    ["missingRecorded", "missingIssued", "missingReservation", "mismatched", "duplicate", "unexpected"],
    "receipt.payload.refusalCounts",
  );
  for (const field of [
    "missingRecorded",
    "missingIssued",
    "missingReservation",
    "mismatched",
    "duplicate",
    "unexpected",
  ] as const) {
    assertNonNegativeInteger(refusals[field], `receipt.payload.refusalCounts.${field}`);
  }
  if (typeof payload.cutoverEligible !== "boolean") throw new Error("receipt.payload.cutoverEligible must be boolean.");
  assertUtcMillisecondInstant(payload.startedAt, "receipt.payload.startedAt");
  assertUtcMillisecondInstant(payload.completedAt, "receipt.payload.completedAt");
  const refusalTotal = [
    refusals.missingRecorded,
    refusals.missingIssued,
    refusals.missingReservation,
    refusals.mismatched,
    refusals.duplicate,
    refusals.unexpected,
  ].reduce<number>((total, count) => total + Number(count), 0);
  const exact =
    payload.completeSignupCount === payload.validIssuedCount &&
    payload.completeSignupCount === payload.validReservedCount &&
    refusalTotal === 0;
  if (payload.cutoverEligible !== exact)
    throw new Error("receipt.payload.cutoverEligible is not the exact coverage result.");
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

function assertNonNegativeInteger(value: unknown, fieldName: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${fieldName} must be a non-negative integer.`);
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

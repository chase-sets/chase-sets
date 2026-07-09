import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed webhook callbacks for agent platforms (issue #3755).
 *
 * The marketplace is the *sender*: it computes an HMAC-SHA256 over a canonical
 * signing base and ships the digest in a structured signature header. This is
 * the shared-secret realisation of the RFC 9421 posture agreed for the agent
 * connector — a single deterministic signing base, one algorithm, an explicit
 * timestamp to bound replay windows.
 *
 * Signing base (exactly, no trailing newline):
 *   `${timestampSeconds}.${rawJsonBody}`
 *
 * Header (`Agent-Webhook-Signature`):
 *   `t=<unixSeconds>,v1=<lowercase-hex HMAC-SHA256>`
 *
 * Integrators verify by recomputing the HMAC with their registered signing
 * secret over the same base and comparing in constant time, rejecting requests
 * whose timestamp is outside a tolerance window.
 */
export const AGENT_WEBHOOK_SIGNATURE_HEADER = "agent-webhook-signature";
export const AGENT_WEBHOOK_ID_HEADER = "agent-webhook-id";
export const AGENT_WEBHOOK_EVENT_TYPE_HEADER = "agent-webhook-event-type";
export const AGENT_WEBHOOK_SIGNATURE_SCHEME_VERSION = "v1";
export const AGENT_WEBHOOK_SIGNING_SECRET_PREFIX = "whsec";

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SIGNING_SECRET_BYTES = 32;

export type AgentWebhookSignature = Readonly<{
  /** Unix timestamp (seconds) bound into the signature base. */
  timestamp: number;
  /** Structured header value: `t=<seconds>,v1=<hex>`. */
  header: string;
  /** Raw lowercase-hex HMAC-SHA256 digest. */
  signature: string;
}>;

export type SignAgentWebhookInput = Readonly<{
  signingSecret: string;
  body: string;
  timestampSeconds: number;
}>;

/** Generate a fresh, high-entropy signing secret (returned once, at registration). */
export function generateAgentWebhookSigningSecret(): string {
  return `${AGENT_WEBHOOK_SIGNING_SECRET_PREFIX}_${randomBytes(SIGNING_SECRET_BYTES).toString("base64url")}`;
}

/** Non-reversible preview safe to surface in APIs/logs (never the full secret). */
export function previewAgentWebhookSigningSecret(signingSecret: string): string {
  const trimmed = signingSecret.trim();
  if (trimmed.length <= 8) {
    return `${AGENT_WEBHOOK_SIGNING_SECRET_PREFIX}_…`;
  }
  return `${AGENT_WEBHOOK_SIGNING_SECRET_PREFIX}_…${trimmed.slice(-4)}`;
}

function signingBase(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function computeAgentWebhookDigest(input: SignAgentWebhookInput): string {
  return createHmac("sha256", input.signingSecret)
    .update(signingBase(input.timestampSeconds, input.body))
    .digest("hex");
}

export function signAgentWebhookPayload(input: SignAgentWebhookInput): AgentWebhookSignature {
  const signature = computeAgentWebhookDigest(input);
  return {
    timestamp: input.timestampSeconds,
    signature,
    header: `t=${input.timestampSeconds},${AGENT_WEBHOOK_SIGNATURE_SCHEME_VERSION}=${signature}`,
  };
}

export type VerifyAgentWebhookInput = Readonly<{
  signingSecret: string;
  body: string;
  header: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}>;

/**
 * Reference verifier for integrators (and our own delivery tests). Constant-time
 * digest comparison plus a bounded replay window over the signed timestamp.
 */
export function verifyAgentWebhookSignature(input: VerifyAgentWebhookInput): boolean {
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) {
    return false;
  }
  const tolerance = input.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - parsed.timestamp) > tolerance) {
    return false;
  }
  const expected = computeAgentWebhookDigest({
    signingSecret: input.signingSecret,
    body: input.body,
    timestampSeconds: parsed.timestamp,
  });
  return timingSafeHexEqual(expected, parsed.signature);
}

function parseSignatureHeader(header: string): { timestamp: number; signature: string } | null {
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (trimmedKey === "t") {
      const parsed = Number.parseInt(trimmedValue, 10);
      timestamp = Number.isFinite(parsed) ? parsed : null;
    } else if (trimmedKey === AGENT_WEBHOOK_SIGNATURE_SCHEME_VERSION) {
      signature = /^[0-9a-f]+$/i.test(trimmedValue) ? trimmedValue.toLowerCase() : null;
    }
  }
  if (timestamp === null || signature === null) {
    return null;
  }
  return { timestamp, signature };
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

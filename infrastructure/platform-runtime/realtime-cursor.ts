import { createHmac, timingSafeEqual } from "node:crypto";
import type { RealtimeCursor } from "./realtime-outbox-store";
import type { RealtimeCursorSigningKeySet } from "./realtime";

type RealtimeCursorEnvelope = Readonly<{
  v: 1;
  positions: RealtimeCursor;
  sig?: string;
}>;

export function encodeRealtimeCursor(cursor: RealtimeCursor, signingKeys?: RealtimeCursorSigningKeySet): string {
  const currentSigningSecret = resolveCurrentRealtimeCursorSigningSecret(signingKeys);
  const envelope: RealtimeCursorEnvelope = {
    v: 1,
    positions: cursor,
  };
  const unsignedPayload = stableJson(envelope);
  const signedEnvelope = currentSigningSecret
    ? { ...envelope, sig: signRealtimeCursorPayload(unsignedPayload, currentSigningSecret) }
    : envelope;

  return Buffer.from(stableJson(signedEnvelope), "utf8").toString("base64url");
}

export function decodeRealtimeCursor(
  value: string | null | undefined,
  signingKeys?: RealtimeCursorSigningKeySet,
): RealtimeCursor {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    if ("v" in parsed || "positions" in parsed || "sig" in parsed) {
      return decodeRealtimeCursorEnvelope(parsed, signingKeys);
    }

    if (resolveRealtimeCursorSigningSecrets(signingKeys).length > 0) {
      return {};
    }

    return sanitizeRealtimeCursor(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function decodeRealtimeCursorEnvelope(
  parsed: object,
  signingKeys: RealtimeCursorSigningKeySet | undefined,
): RealtimeCursor {
  const envelope = parsed as Partial<RealtimeCursorEnvelope>;
  if (envelope.v !== 1 || !envelope.positions || typeof envelope.positions !== "object") {
    return {};
  }

  const signingSecrets = resolveRealtimeCursorSigningSecrets(signingKeys);
  if (signingSecrets.length > 0) {
    const sig = typeof envelope.sig === "string" ? envelope.sig : "";
    const unsignedPayload = stableJson({ v: 1, positions: envelope.positions });
    if (!signingSecrets.some((secret) => isValidRealtimeCursorSignature(unsignedPayload, sig, secret))) {
      return {};
    }
  }

  return sanitizeRealtimeCursor(envelope.positions as Record<string, unknown>);
}

function sanitizeRealtimeCursor(value: Record<string, unknown>): RealtimeCursor {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([, position]) => /^(0|[1-9]\d*)$/.test(position)),
  );
}

function signRealtimeCursorPayload(payload: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(payload).digest("base64url");
}

function isValidRealtimeCursorSignature(payload: string, signature: string, signingSecret: string): boolean {
  const expected = signRealtimeCursorPayload(payload, signingSecret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function resolveCurrentRealtimeCursorSigningSecret(
  signingKeys: RealtimeCursorSigningKeySet | undefined,
): string | undefined {
  return typeof signingKeys === "string" ? signingKeys : signingKeys?.current;
}

function resolveRealtimeCursorSigningSecrets(signingKeys: RealtimeCursorSigningKeySet | undefined): readonly string[] {
  if (!signingKeys) {
    return [];
  }

  return typeof signingKeys === "string"
    ? [signingKeys]
    : [signingKeys.current, ...(signingKeys.previous ?? [])].filter(Boolean);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }

  return value;
}

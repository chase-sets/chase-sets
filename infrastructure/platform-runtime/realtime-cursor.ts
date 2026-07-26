import {
  canonicalSigningJson,
  isValidCanonicalPayloadSignatureForKeySet,
  resolveCurrentSigningSecret,
  resolveSigningSecrets,
  signCanonicalPayload,
} from "./signed-payload";
import type { RealtimeCursor } from "./realtime-outbox-store";
import type { RealtimeCursorSigningKeySet } from "./realtime";

type RealtimeCursorEnvelope = Readonly<{
  v: 1;
  positions: RealtimeCursor;
  sig?: string;
}>;

export function encodeRealtimeCursor(cursor: RealtimeCursor, signingKeys?: RealtimeCursorSigningKeySet): string {
  const currentSigningSecret = resolveCurrentSigningSecret(signingKeys);
  const envelope: RealtimeCursorEnvelope = {
    v: 1,
    positions: cursor,
  };
  const unsignedPayload = canonicalSigningJson(envelope);
  const signedEnvelope = currentSigningSecret
    ? { ...envelope, sig: signCanonicalPayload(unsignedPayload, currentSigningSecret) }
    : envelope;

  return Buffer.from(canonicalSigningJson(signedEnvelope), "utf8").toString("base64url");
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

    if (resolveSigningSecrets(signingKeys).length > 0) {
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

  if (resolveSigningSecrets(signingKeys).length > 0) {
    const sig = typeof envelope.sig === "string" ? envelope.sig : "";
    const unsignedPayload = canonicalSigningJson({ v: 1, positions: envelope.positions });
    if (!isValidCanonicalPayloadSignatureForKeySet(unsignedPayload, sig, signingKeys)) {
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

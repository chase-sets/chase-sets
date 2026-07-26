import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A rotating HMAC signing key set for server-minted opaque payloads.
 *
 * The `current` key signs; `current` plus every `previous` key verifies. A
 * rotation is therefore two operator steps -- promote the new key to `current`
 * while the outgoing key moves into `previous`, then drop `previous` once every
 * payload minted under it has aged past its freshness window. A bare string is
 * the degenerate single-key set.
 */
export type SigningKeySet =
  | string
  | Readonly<{
      current: string;
      previous?: readonly string[];
    }>;

/**
 * Canonical JSON for signing: object keys sorted, `undefined` members dropped,
 * array order preserved exactly as given.
 *
 * Array order being preserved is the load-bearing property. A signature taken
 * over this string covers the order of every array in the payload, so
 * reordering a signed list is tampering rather than an equivalent encoding of
 * the same value.
 */
export function canonicalSigningJson(value: unknown): string {
  return JSON.stringify(sortSigningJson(value));
}

function sortSigningJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSigningJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortSigningJson(entryValue)]),
    );
  }

  return value;
}

export function signCanonicalPayload(payload: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(payload).digest("base64url");
}

export function isValidCanonicalPayloadSignature(payload: string, signature: string, signingSecret: string): boolean {
  const expected = signCanonicalPayload(payload, signingSecret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verify a signature against every key in the set.
 *
 * Deliberately does not short-circuit on the first match: each candidate is
 * compared with `timingSafeEqual` and all of them are always compared, so
 * neither the verdict nor the wall-clock cost reveals which key in the rotation
 * matched. An empty key set verifies nothing -- callers that must never accept
 * an unsigned payload are responsible for treating an empty set as a
 * misconfiguration rather than as "signing disabled".
 */
export function isValidCanonicalPayloadSignatureForKeySet(
  payload: string,
  signature: string,
  signingKeys: SigningKeySet | undefined,
): boolean {
  let valid = false;
  for (const signingSecret of resolveSigningSecrets(signingKeys)) {
    if (isValidCanonicalPayloadSignature(payload, signature, signingSecret)) {
      valid = true;
    }
  }

  return valid;
}

export function resolveCurrentSigningSecret(signingKeys: SigningKeySet | undefined): string | undefined {
  return typeof signingKeys === "string" ? signingKeys : signingKeys?.current;
}

export function resolveSigningSecrets(signingKeys: SigningKeySet | undefined): readonly string[] {
  if (!signingKeys) {
    return [];
  }

  return typeof signingKeys === "string"
    ? [signingKeys]
    : [signingKeys.current, ...(signingKeys.previous ?? [])].filter(Boolean);
}

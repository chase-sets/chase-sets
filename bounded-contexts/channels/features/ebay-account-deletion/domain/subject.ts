import { createHmac, hkdfSync } from "node:crypto";
import {
  openSecretEnvelope,
  sealSecretEnvelope,
  type SecretEnvelopeBytes,
} from "@chase-sets/platform-runtime/secret-envelope";
import type { ChannelCredentialKeyring } from "../../credentials/domain/contracts";
import { assertKeyringContinuity } from "../../credentials/domain/codecs";

export const ebaySubjectRootKeyId = "ebay-subject-root-v1";
export class EbayReceiptError extends Error {
  constructor(public readonly code: "invalid-notice" | "unavailable" | "storage-unavailable") {
    super(code);
    this.name = "EbayReceiptError";
  }
}

export function assertEbaySubject(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 1024 ||
    /[\u0000\uD800-\uDFFF]/u.test(value)
  )
    throw new EbayReceiptError("invalid-notice");
}

export function parseEbaySubjectFingerprint(value: string) {
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1] !== ebaySubjectRootKeyId || !/^[a-f0-9]{64}$/.test(parts[2]!))
    throw new EbayReceiptError("unavailable");
  return { rootKeyId: parts[1], digest: parts[2] };
}

export function assertEbaySubjectKeyringContinuity(
  previous: ChannelCredentialKeyring,
  next: ChannelCredentialKeyring,
  references: readonly Readonly<{ fingerprint: string; keyId: string }>[],
) {
  try {
    assertKeyringContinuity(previous, next);
    for (const reference of references) {
      const { rootKeyId } = parseEbaySubjectFingerprint(reference.fingerprint);
      if (!next.keys.has(rootKeyId) || !next.keys.has(reference.keyId)) throw new Error();
    }
  } catch {
    throw new EbayReceiptError("unavailable");
  }
}

export function createEbaySubjectCipher(configured: ChannelCredentialKeyring | null = null) {
  const keys = new Map([...(configured?.keys ?? [])].map(([id, bytes]) => [id, Buffer.from(bytes)]));
  const activeKeyId = configured?.activeKeyId;
  function key(id: string | undefined) {
    const result = id === undefined ? undefined : keys.get(id);
    if (!result || result.length !== 32) throw new EbayReceiptError("unavailable");
    return result;
  }
  function fingerprint(userId: string, rootKeyId = ebaySubjectRootKeyId) {
    assertEbaySubject(userId);
    if (rootKeyId !== ebaySubjectRootKeyId) throw new EbayReceiptError("unavailable");
    const derived = Buffer.from(hkdfSync("sha256", key(rootKeyId), "channels.ebay-subject/v1", "fingerprint", 32));
    try {
      return `v1:${rootKeyId}:${createHmac("sha256", derived).update(userId, "utf8").digest("hex")}`;
    } finally {
      derived.fill(0);
    }
  }
  function aad(binding: string, keyId: string) {
    return Buffer.from(JSON.stringify(["EbaySubjectEnvelope/v1", binding, keyId]));
  }
  function assertAvailable(reference: Readonly<{ fingerprint: string; keyId: string }>) {
    key(parseEbaySubjectFingerprint(reference.fingerprint).rootKeyId);
    key(reference.keyId);
  }
  return {
    fingerprint,
    assertAvailable,
    seal(binding: string, userId: string) {
      assertEbaySubject(userId);
      if (activeKeyId === ebaySubjectRootKeyId) throw new EbayReceiptError("unavailable");
      const fingerprintValue = fingerprint(userId);
      const bytes = Buffer.from(userId);
      try {
        const sealed = sealSecretEnvelope(key(activeKeyId), aad(binding, activeKeyId!), bytes);
        return { ...sealed, keyId: activeKeyId!, fingerprint: fingerprintValue };
      } catch {
        throw new EbayReceiptError("unavailable");
      } finally {
        bytes.fill(0);
      }
    },
    open(binding: string, sealed: SecretEnvelopeBytes & Readonly<{ keyId: string; fingerprint: string }>) {
      assertAvailable(sealed);
      try {
        const bytes = openSecretEnvelope(key(sealed.keyId), aad(binding, sealed.keyId), sealed);
        try {
          const userId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (fingerprint(userId, parseEbaySubjectFingerprint(sealed.fingerprint).rootKeyId) !== sealed.fingerprint)
            throw new Error();
          return userId;
        } finally {
          bytes.fill(0);
        }
      } catch {
        throw new EbayReceiptError("unavailable");
      }
    },
  };
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretEnvelopeBytes = Readonly<{ iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }>;

export function sealSecretEnvelope(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): SecretEnvelopeBytes {
  try {
    if (key.length !== 32) throw new Error();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    return { iv, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), tag: cipher.getAuthTag() };
  } catch {
    throw new Error("secret-envelope-unavailable");
  }
}

export function openSecretEnvelope(key: Uint8Array, aad: Uint8Array, sealed: SecretEnvelopeBytes): Buffer {
  try {
    if (key.length !== 32 || sealed.iv.length !== 12 || sealed.tag.length !== 16) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, sealed.iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    cipher.setAuthTag(Buffer.from(sealed.tag));
    const pending = cipher.update(sealed.ciphertext);
    try {
      return Buffer.concat([pending, cipher.final()]);
    } finally {
      pending.fill(0);
    }
  } catch {
    throw new Error("secret-envelope-unavailable");
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretEnvelopeBytes = Readonly<{ iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }>;

export type SecretEnvelopeKeyring = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

export class SecretEnvelopeKeyringError extends Error {
  constructor(public readonly code: "invalid-keyring") {
    super(code);
    this.name = "SecretEnvelopeKeyringError";
  }
}

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

function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error();
}

export function parseSecretEnvelopeKeyring(json: string | undefined): SecretEnvelopeKeyring | null {
  if (json === undefined || json === "") return null;
  try {
    if (Buffer.byteLength(json) > 16384) throw new Error();
    const value: unknown = JSON.parse(json);
    // JSON.parse accepts duplicate names. Inspect JSON string tokens, not substrings inside values.
    const objects: Set<string>[] = [];
    for (const match of json.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/gs)) {
      if (match[0] === "{") objects.push(new Set());
      else if (match[0] === "}") objects.pop();
      else if (/^\s*:/.test(json.slice(match.index + match[0].length))) {
        const key: string = JSON.parse(match[0]);
        const names = objects.at(-1);
        if (!names || names.has(key)) throw new Error();
        names.add(key);
      }
    }
    closed(value, ["activeKeyId", "keys"]);
    if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 32) throw new Error();
    const keys = new Map<string, Uint8Array>();
    for (const entry of value.keys) {
      closed(entry, ["keyId", "keyBase64"]);
      if (
        typeof entry.keyId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(entry.keyId) ||
        keys.has(entry.keyId) ||
        typeof entry.keyBase64 !== "string"
      )
        throw new Error();
      const key = Buffer.from(entry.keyBase64, "base64");
      if (key.length !== 32 || key.toString("base64") !== entry.keyBase64) throw new Error();
      keys.set(entry.keyId, key);
    }
    if (typeof value.activeKeyId !== "string" || !keys.has(value.activeKeyId)) throw new Error();
    return { activeKeyId: value.activeKeyId, keys };
  } catch {
    throw new SecretEnvelopeKeyringError("invalid-keyring");
  }
}

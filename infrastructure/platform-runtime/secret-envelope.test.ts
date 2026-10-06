import { describe, expect, it } from "vitest";
import {
  openSecretEnvelope,
  parseSecretEnvelopeKeyring,
  sealSecretEnvelope,
  SecretEnvelopeKeyringError,
} from "./secret-envelope";

const keyBase64 = Buffer.alloc(32, 7).toString("base64");
const key = { keyId: "synthetic", keyBase64 };
const valid = JSON.stringify({ activeKeyId: "synthetic", keys: [key] });

describe("secret-envelope-keyring-parity", () => {
  it("accepts absent, empty, valid one-key, and valid 32-key rings", () => {
    expect(parseSecretEnvelopeKeyring(undefined)).toBeNull();
    expect(parseSecretEnvelopeKeyring("")).toBeNull();
    expect(parseSecretEnvelopeKeyring(valid)?.activeKeyId).toBe("synthetic");
    const keys = Array.from({ length: 32 }, (_, index) => ({
      keyId: `key-${index}`,
      keyBase64: Buffer.alloc(32, index).toString("base64"),
    }));
    const json = JSON.stringify({ activeKeyId: "key-0", keys });
    expect(parseSecretEnvelopeKeyring(json)?.keys.size).toBe(32);
    expect(parseSecretEnvelopeKeyring(json + " ".repeat(16384 - Buffer.byteLength(json)))?.keys.size).toBe(32);
  });

  it.each([
    ["duplicate top-level name", valid.replace('{"activeKeyId":', '{"activeKeyId":"synthetic","activeKeyId":')],
    ["duplicate nested name", valid.replace('{"keyId":', '{"keyId":"synthetic","keyId":')],
    ["nested unknown key", JSON.stringify({ activeKeyId: "synthetic", keys: [{ ...key, extra: true }] })],
    ["top-level unknown key", JSON.stringify({ activeKeyId: "synthetic", keys: [key], extra: true })],
    ["zero keys", JSON.stringify({ activeKeyId: "synthetic", keys: [] })],
    [
      "33 keys",
      JSON.stringify({
        activeKeyId: "synthetic",
        keys: [key, ...Array.from({ length: 32 }, (_, index) => ({ ...key, keyId: `key-${index}` }))],
      }),
    ],
    ["duplicate key id", JSON.stringify({ activeKeyId: "synthetic", keys: [key, key] })],
    ["bad key id", JSON.stringify({ activeKeyId: "synthetic", keys: [{ ...key, keyId: "bad id" }] })],
    [
      "31-byte key",
      JSON.stringify({ activeKeyId: "synthetic", keys: [{ ...key, keyBase64: Buffer.alloc(31).toString("base64") }] }),
    ],
    [
      "33-byte key",
      JSON.stringify({ activeKeyId: "synthetic", keys: [{ ...key, keyBase64: Buffer.alloc(33).toString("base64") }] }),
    ],
    ["unknown active key", JSON.stringify({ activeKeyId: "missing", keys: [key] })],
    [
      "non-canonical base64",
      JSON.stringify({ activeKeyId: "synthetic", keys: [{ ...key, keyBase64: `${keyBase64}=` }] }),
    ],
    ["16385-byte document", valid + " ".repeat(16385 - Buffer.byteLength(valid))],
  ])("rejects %s", (_name, json) => {
    expect(() => parseSecretEnvelopeKeyring(json)).toThrowError(new SecretEnvelopeKeyringError("invalid-keyring"));
  });

  it("bounds malformed JSON errors without retaining input", () => {
    let refusal: unknown;
    try {
      parseSecretEnvelopeKeyring("malformed-synthetic-marker");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SecretEnvelopeKeyringError);
    expect(refusal).toMatchObject({ code: "invalid-keyring", message: "invalid-keyring" });
    expect(String(refusal)).not.toContain("malformed-synthetic-marker");
    expect(refusal).not.toHaveProperty("cause");
  });

  it("preserves cipher authentication", () => {
    const rawKey = Buffer.alloc(32, 3);
    const aad = Buffer.from("operator-session");
    const sealed = sealSecretEnvelope(rawKey, aad, Buffer.from("payload"));
    expect(openSecretEnvelope(rawKey, aad, sealed).toString()).toBe("payload");
    expect(() => openSecretEnvelope(rawKey, Buffer.from("tampered"), sealed)).toThrow("secret-envelope-unavailable");
  });
});

import { describe, expect, it } from "vitest";
import {
  decodeTokenSet,
  encodeTokenSet,
  encodeEnvelopeAad,
  parseChannelCredentialKeyring,
  nextCredentialCounter,
  assertKeyringContinuity,
} from "../domain/codecs";
import { openSecretEnvelope, sealSecretEnvelope } from "../../../support/runtime-support/secret-envelope";

export const tokenSet = {
  format: "ChannelOAuthTokenSet/v1" as const,
  accessToken: "synthetic-access-😀",
  refresh: { kind: "present" as const, token: "synthetic-refresh", expiresAt: null },
  accessExpiresAt: "2028-02-29T01:02:03+01:00",
  issuedAt: "2026-09-23T00:00:00Z",
};
export const envelope = {
  version: "ChannelCredentialEnvelope/v1" as const,
  rowId: "credential-synthetic-1",
  kind: "oauth-token-set" as const,
  providerKey: "synthetic",
  environment: "sandbox" as const,
  accountId: "account-1",
  connectionId: "connection-1",
  payloadFormat: tokenSet.format,
  tokenGeneration: 1,
  envelopeRevision: 1,
  keyId: "key1",
  createdAt: tokenSet.issuedAt,
  updatedAt: tokenSet.issuedAt,
};

describe("Channel credential canonical codecs", () => {
  it("never defaults missing fields, including nested refresh fields", () => {
    for (const field of Object.keys(tokenSet))
      expect(() =>
        encodeTokenSet(Object.fromEntries(Object.entries(tokenSet).filter(([key]) => key !== field))),
      ).toThrow("invalid-payload");
    for (const field of Object.keys(tokenSet.refresh))
      expect(() =>
        encodeTokenSet({
          ...tokenSet,
          refresh: Object.fromEntries(Object.entries(tokenSet.refresh).filter(([key]) => key !== field)),
        }),
      ).toThrow("invalid-payload");
    const duplicateRefresh = encodeTokenSet(tokenSet)
      .toString()
      .replace('"kind":"present"', '"kind":"present","kind":"present"');
    expect(() => decodeTokenSet(Buffer.from(duplicateRefresh))).toThrow("invalid-payload");
  });
  it("pins AAD field order and both positive safe-integer counters", () => {
    expect(encodeEnvelopeAad(envelope).toString()).toBe(
      JSON.stringify([
        "ChannelCredentialEnvelope/v1",
        "credential-synthetic-1",
        "oauth-token-set",
        "synthetic",
        "sandbox",
        "account-1",
        "connection-1",
        "ChannelOAuthTokenSet/v1",
        1,
        1,
        "key1",
        "2026-09-23T00:00:00Z",
        "2026-09-23T00:00:00Z",
      ]),
    );
    expect(nextCredentialCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])
      expect(() => nextCredentialCounter(value)).toThrow("counter-overflow");
  });
  it("bounds keyring count and exact UTF-8 size and rejects key-ID reassignment", () => {
    const keys = Array.from({ length: 32 }, (_, index) => ({
      keyId: `synthetic-${index}`,
      keyBase64: Buffer.alloc(32, index).toString("base64"),
    }));
    const json = JSON.stringify({ activeKeyId: "synthetic-0", keys });
    const ring = parseChannelCredentialKeyring(json)!;
    expect(ring.keys.size).toBe(32);
    expect(parseChannelCredentialKeyring(json + " ".repeat(16384 - Buffer.byteLength(json)))?.keys.size).toBe(32);
    expect(() => parseChannelCredentialKeyring(json + " ".repeat(16385 - Buffer.byteLength(json)))).toThrow(
      "invalid-keyring",
    );
    expect(() =>
      parseChannelCredentialKeyring(
        JSON.stringify({ activeKeyId: "synthetic-0", keys: [...keys, { ...keys[0], keyId: "synthetic-32" }] }),
      ),
    ).toThrow("invalid-keyring");
    expect(() =>
      assertKeyringContinuity(ring, {
        activeKeyId: "synthetic-0",
        keys: new Map([["synthetic-0", Buffer.alloc(32, 99)]]),
      }),
    ).toThrow("invalid-keyring");
    expect(() => assertKeyringContinuity(ring, ring)).not.toThrow();
  });
  it("round-trips ordered Unicode bytes and explicit absent/null fields", () => {
    for (const value of [tokenSet, { ...tokenSet, refresh: { kind: "absent" }, accessExpiresAt: null }]) {
      const bytes = encodeTokenSet(value);
      expect(encodeTokenSet(decodeTokenSet(bytes))).toEqual(bytes);
      expect(decodeTokenSet(bytes)).toEqual(value);
    }
  });
  it.each([
    { ...tokenSet, extra: true },
    { ...tokenSet, accessToken: "" },
    { ...tokenSet, accessToken: "\u0000" },
    { ...tokenSet, accessToken: "\ud800" },
    { ...tokenSet, accessToken: "a".repeat(16385) },
    { ...tokenSet, refresh: { kind: "absent", token: "extra" } },
    { ...tokenSet, refresh: { kind: "present", token: "x" } },
    { ...tokenSet, issuedAt: "2026-02-29T00:00:00Z" },
    { ...tokenSet, issuedAt: "2026-04-31T00:00:00Z" },
    { ...tokenSet, issuedAt: "2026-01-01" },
    { ...tokenSet, issuedAt: "2026-01-01T24:00:00Z" },
    { ...tokenSet, issuedAt: "2026-01-01T00:00:00+24:00" },
    { ...tokenSet, refresh: { kind: "present", token: "x", expiresAt: "bad" } },
    { ...tokenSet, format: "ChannelOAuthTokenSet/v2" },
  ])("rejects malformed closed input %#", (value) => expect(() => encodeTokenSet(value)).toThrow("invalid-payload"));
  it("rejects duplicate keys, noncanonical encoding, BOM and malformed UTF-8", () => {
    const canonical = encodeTokenSet(tokenSet).toString("utf8");
    for (const text of [
      " " + canonical,
      canonical + "\n",
      "\ufeff" + canonical,
      canonical.replace('"accessToken":', '"format":"ChannelOAuthTokenSet/v1","accessToken":'),
      canonical.replace("synthetic", "\\u0073ynthetic"),
      JSON.stringify(Object.fromEntries(Object.entries(tokenSet).reverse())),
    ])
      expect(() => decodeTokenSet(Buffer.from(text))).toThrow("invalid-payload");
    expect(() => decodeTokenSet(Buffer.from([0xc0, 0xaf]))).toThrow("invalid-payload");
  });
  it("enforces exact token and whole-payload byte caps", () => {
    expect(decodeTokenSet(encodeTokenSet({ ...tokenSet, accessToken: "😀".repeat(4096) })).accessToken).toHaveLength(
      8192,
    );
    expect(() => encodeTokenSet({ ...tokenSet, accessToken: "😀".repeat(4096) + "a" })).toThrow();
    const base = {
      ...tokenSet,
      accessToken: "a".repeat(16384),
      refresh: { kind: "present", token: "x", expiresAt: null },
    };
    const remaining = 32768 - encodeTokenSet(base).length;
    const exact = { ...base, refresh: { ...base.refresh, token: "x".repeat(remaining + 1) } };
    expect(encodeTokenSet(exact)).toHaveLength(32768);
    expect(() =>
      encodeTokenSet({ ...exact, refresh: { ...exact.refresh, token: exact.refresh.token + "x" } }),
    ).toThrow();
  });
  it("authenticates every AAD member and rejects all binary length changes", () => {
    const key = Buffer.alloc(32, 7);
    const bytes = encodeTokenSet(tokenSet);
    const sealed = sealSecretEnvelope(key, encodeEnvelopeAad(envelope), bytes);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(sealSecretEnvelope(key, encodeEnvelopeAad(envelope), bytes).iv).not.toEqual(sealed.iv);
    expect(openSecretEnvelope(key, encodeEnvelopeAad(envelope), sealed)).toEqual(bytes);
    for (const [field, value] of Object.entries(envelope)) {
      const changed = { ...envelope, [field]: typeof value === "number" ? value + 1 : value + "x" };
      expect(() => openSecretEnvelope(key, encodeEnvelopeAad(changed), sealed)).toThrow();
    }
    for (const field of ["iv", "tag", "ciphertext"] as const) {
      expect(() =>
        openSecretEnvelope(key, encodeEnvelopeAad(envelope), { ...sealed, [field]: sealed[field].subarray(1) }),
      ).toThrow();
    }
    expect(() => openSecretEnvelope(Buffer.alloc(31), encodeEnvelopeAad(envelope), sealed)).toThrow();
    for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeEnvelopeAad({ ...envelope, tokenGeneration: value })).toThrow();
      expect(() => encodeEnvelopeAad({ ...envelope, envelopeRevision: value })).toThrow();
    }
  });
  it("parses only a closed bounded keyring with one active named key", () => {
    const key = { keyId: "key1", keyBase64: Buffer.alloc(32, 7).toString("base64") };
    expect(parseChannelCredentialKeyring(undefined)).toBeNull();
    expect(parseChannelCredentialKeyring("")).toBeNull();
    expect(parseChannelCredentialKeyring(JSON.stringify({ activeKeyId: "key1", keys: [key] }))?.activeKeyId).toBe(
      "key1",
    );
    for (const value of [
      { activeKeyId: "key1", keys: [] },
      { activeKeyId: "missing", keys: [key] },
      { activeKeyId: "key1", keys: [key, key] },
      { activeKeyId: "key1", keys: [key], extra: true },
      { activeKeyId: "key1", keys: [{ ...key, extra: true }] },
      { activeKeyId: "key1", keys: [{ ...key, keyBase64: key.keyBase64.slice(0, -1) }] },
      { activeKeyId: "key1", keys: [{ ...key, keyId: "not.allowed" }] },
    ])
      expect(() => parseChannelCredentialKeyring(JSON.stringify(value))).toThrow("invalid-keyring");
    expect(() => parseChannelCredentialKeyring(" ".repeat(16385))).toThrow("invalid-keyring");
    expect(() => parseChannelCredentialKeyring('{"activeKeyId":"a","activeKeyId":"key1","keys":[]}')).toThrow();
  });
});

import {
  assertChannelEnvironment,
  assertCredentialReference,
  assertOpaqueId,
  assertProviderKey,
} from "../../connections/domain/validation";
import { ChannelCredentialError, type ChannelCredentialKeyring, type ChannelOAuthTokenSet } from "./contracts";

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

function token(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 16384
  )
    throw new Error();
}

export function assertCredentialInstant(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error();
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) throw new Error();
  const [, year, month, day, hour, minute, second, , zoneHour, zoneMinute] = match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(zoneHour ?? 0) > 23 ||
    Number(zoneMinute ?? 0) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error();
}

export function encodeTokenSet(value: unknown): Buffer {
  try {
    closed(value, ["format", "accessToken", "refresh", "accessExpiresAt", "issuedAt"]);
    if (value.format !== "ChannelOAuthTokenSet/v1") throw new Error();
    token(value.accessToken);
    assertCredentialInstant(value.issuedAt);
    if (value.accessExpiresAt !== null) assertCredentialInstant(value.accessExpiresAt);
    const refresh = value.refresh;
    if (!refresh || typeof refresh !== "object") throw new Error();
    let canonicalRefresh: ChannelOAuthTokenSet["refresh"];
    if ("kind" in refresh && refresh.kind === "absent") {
      closed(refresh, ["kind"]);
      canonicalRefresh = { kind: "absent" };
    } else {
      closed(refresh, ["kind", "token", "expiresAt"]);
      if (refresh.kind !== "present") throw new Error();
      token(refresh.token);
      if (refresh.expiresAt !== null) assertCredentialInstant(refresh.expiresAt);
      canonicalRefresh = { kind: "present", token: refresh.token, expiresAt: refresh.expiresAt };
    }
    const result = Buffer.from(
      JSON.stringify({
        format: value.format,
        accessToken: value.accessToken,
        refresh: canonicalRefresh,
        accessExpiresAt: value.accessExpiresAt,
        issuedAt: value.issuedAt,
      }),
    );
    if (result.length > 32768) throw new Error();
    return result;
  } catch {
    throw new ChannelCredentialError("invalid-payload");
  }
}

export function decodeTokenSet(bytes: Uint8Array): ChannelOAuthTokenSet {
  try {
    if (bytes.length > 32768) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!encodeTokenSet(value).equals(bytes)) throw new Error();
    return value as ChannelOAuthTokenSet;
  } catch {
    throw new ChannelCredentialError("invalid-payload");
  }
}

export function encodeEnvelopeAad(value: unknown): Buffer {
  try {
    closed(value, [
      "version",
      "rowId",
      "kind",
      "providerKey",
      "environment",
      "accountId",
      "connectionId",
      "payloadFormat",
      "tokenGeneration",
      "envelopeRevision",
      "keyId",
      "createdAt",
      "updatedAt",
    ]);
    if (
      value.version !== "ChannelCredentialEnvelope/v1" ||
      value.kind !== "oauth-token-set" ||
      value.payloadFormat !== "ChannelOAuthTokenSet/v1"
    )
      throw new Error();
    assertCredentialReference(value.rowId);
    assertProviderKey(value.providerKey);
    assertChannelEnvironment(value.environment);
    assertOpaqueId(value.accountId, "accountId");
    assertOpaqueId(value.connectionId, "connectionId");
    for (const counter of [value.tokenGeneration, value.envelopeRevision])
      if (!Number.isSafeInteger(counter) || Number(counter) < 1) throw new Error();
    if (typeof value.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.keyId)) throw new Error();
    assertCredentialInstant(value.createdAt);
    assertCredentialInstant(value.updatedAt);
    return Buffer.from(
      JSON.stringify([
        value.version,
        value.rowId,
        value.kind,
        value.providerKey,
        value.environment,
        value.accountId,
        value.connectionId,
        value.payloadFormat,
        value.tokenGeneration,
        value.envelopeRevision,
        value.keyId,
        value.createdAt,
        value.updatedAt,
      ]),
    );
  } catch {
    throw new ChannelCredentialError("invalid-envelope");
  }
}

export function parseChannelCredentialKeyring(json: string | undefined): ChannelCredentialKeyring | null {
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
    throw new ChannelCredentialError("invalid-keyring");
  }
}

export function assertKeyringContinuity(previous: ChannelCredentialKeyring, next: ChannelCredentialKeyring): void {
  for (const [id, bytes] of previous.keys) {
    const replacement = next.keys.get(id);
    if (replacement && !Buffer.from(bytes).equals(replacement)) throw new ChannelCredentialError("invalid-keyring");
  }
}

export function nextCredentialCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER)
    throw new ChannelCredentialError("counter-overflow");
  return value + 1;
}

import { parseChannelCredentialKeyring } from "../domain/codecs";

export const binding = {
  accountId: "synthetic-account",
  connectionId: "synthetic-connection",
  providerKey: "synthetic",
  environment: "sandbox" as const,
};
export const at = "2026-09-23T00:00:00Z";
export const later = "2026-09-24T00:00:00Z";
export const payload = {
  format: "ChannelOAuthTokenSet/v1" as const,
  accessToken: "synthetic-access-marker",
  refresh: { kind: "present" as const, token: "synthetic-refresh-marker", expiresAt: null },
  accessExpiresAt: null,
  issuedAt: at,
};
export const capability = Object.freeze({});
export function keyring(activeKeyId = "old", ids = ["old", "new"]) {
  return parseChannelCredentialKeyring(
    JSON.stringify({
      activeKeyId,
      keys: ids.map((keyId) => ({ keyId, keyBase64: Buffer.alloc(32, keyId === "old" ? 7 : 8).toString("base64") })),
    }),
  )!;
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SavedListCommandId, SavedListId } from "./contracts";
import type { SavedListCapabilityService, SavedListUnlistedSecret } from "./sharing-contracts";

export type SavedListCapabilityKey = Readonly<{ id: string; secret: string | Uint8Array }>;

export function createSavedListCapabilityService(
  keys: Readonly<{ activeKeyId: string; keys: readonly SavedListCapabilityKey[] }>,
): SavedListCapabilityService {
  const keyring = new Map(
    keys.keys.map((key) => {
      const id = key.id.trim();
      const secret = typeof key.secret === "string" ? Buffer.from(key.secret, "utf8") : Buffer.from(key.secret);
      if (!id || secret.byteLength < 32) {
        throw new Error("Saved List capability keys require a non-empty ID and at least 32 bytes of secret material.");
      }
      return [id, secret] as const;
    }),
  );
  const activeKeyId = keys.activeKeyId.trim();
  if (!keyring.has(activeKeyId)) throw new Error("Saved List active capability key is not present in the keyring.");

  function issue(listId: SavedListId, commandId: SavedListCommandId, keyId: string): SavedListUnlistedSecret {
    const key = keyring.get(keyId);
    if (!key) throw new Error(`Saved List capability key '${keyId}' is unavailable.`);
    const digest = createHmac("sha256", key).update(`saved-list:v1:${listId}:${commandId}`).digest("base64url");
    return `sl1.${keyId}.${digest}` as SavedListUnlistedSecret;
  }
  return {
    mint: ({ listId, commandId }) => {
      const secret = issue(listId, commandId, activeKeyId);
      return { keyId: activeKeyId, secret, verifier: savedListCapabilityVerifier(secret) };
    },
    reissue: ({ listId, commandId, keyId }) => issue(listId, commandId, keyId),
    verifierFor: (secret) => (isSavedListUnlistedSecret(secret) ? savedListCapabilityVerifier(secret) : null),
  };
}

export function savedListCapabilityVerifier(secret: SavedListUnlistedSecret): string {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}
export function isSavedListUnlistedSecret(value: string): value is SavedListUnlistedSecret {
  return /^sl1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(value);
}
export function savedListCapabilityVerifierMatches(candidate: string | null, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

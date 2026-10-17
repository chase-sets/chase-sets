import { createHash } from "node:crypto";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { assert } from "../../../support/runtime-support/common";
import {
  canonicalPreferenceChanges,
  canonicalPreferences,
  type PreferenceChanges,
  type UserPreferences,
} from "./domain";

export const preferenceWriteAttemptEventType = "identity.user-preferences.write-attempt-recorded";

export type PreferenceWriteReceipt = Readonly<{
  schemaVersion: 1;
  userId: UserId;
  keyHash: string;
  requestFingerprint: string;
  changes: PreferenceChanges;
  outcome: "updated" | "unchanged";
  preferenceVersion: number;
  preferences: UserPreferences;
}>;

export function validatePreferenceKey(key: unknown): asserts key is string {
  assert(typeof key === "string" && /^[\x21-\x7e]{1,128}$/.test(key), "User preferences are invalid.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function preferenceWriteIdentity(userId: UserId, key: string, changes: PreferenceChanges) {
  validatePreferenceKey(key);
  const canonical = canonicalPreferenceChanges(changes);
  const keyHash = sha256(key);
  return {
    keyHash,
    streamId: `identity.user-preferences-write-attempt-${userId}-${keyHash}`,
    requestFingerprint: `sha256:${sha256(JSON.stringify({ schemaVersion: 1, action: "set-user-preferences", changes: canonical }))}`,
    changes: canonical,
  };
}

export function readPreferenceWriteReceipt(value: unknown, userId: UserId, keyHash: string): PreferenceWriteReceipt {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid preference write receipt.");
  const data = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "userId",
    "keyHash",
    "requestFingerprint",
    "changes",
    "outcome",
    "preferenceVersion",
    "preferences",
  ];
  assert(
    Object.keys(data).length === fields.length && fields.every((field) => Object.hasOwn(data, field)),
    "Invalid preference write receipt.",
  );
  assert(
    data.schemaVersion === 1 && data.userId === userId && data.keyHash === keyHash && /^[0-9a-f]{64}$/.test(keyHash),
    "Invalid preference write receipt.",
  );
  const changes = canonicalPreferenceChanges(data.changes);
  assert(
    Object.entries(changes).every(([field, value]) => (data.changes as Record<string, unknown>)[field] === value),
    "Invalid preference write receipt.",
  );
  const fingerprint = `sha256:${sha256(JSON.stringify({ schemaVersion: 1, action: "set-user-preferences", changes }))}`;
  assert(
    data.requestFingerprint === fingerprint && (data.outcome === "updated" || data.outcome === "unchanged"),
    "Invalid preference write receipt.",
  );
  assert(
    Number.isSafeInteger(data.preferenceVersion) && (data.preferenceVersion as number) >= 0,
    "Invalid preference write receipt.",
  );
  return {
    schemaVersion: 1,
    userId,
    keyHash,
    requestFingerprint: fingerprint,
    changes,
    outcome: data.outcome as PreferenceWriteReceipt["outcome"],
    preferenceVersion: data.preferenceVersion as number,
    preferences: canonicalPreferences(userId, data.preferences),
  };
}

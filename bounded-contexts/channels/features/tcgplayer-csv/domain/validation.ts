import { createHash } from "node:crypto";
import type { ManualClaimLeasePolicySnapshot, TcgplayerImportSummary } from "./contracts";

export function assertClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be a record.`);
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}

export function assertSafeInteger(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be a safe integer from ${min} through ${max}.`);
  }
}

export function assertTimezoneInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a timezone-bearing instant.`);
  }
}

export function assertBoundedText(value: unknown, label: string, maxLength = 512): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be nonempty and at most ${maxLength} characters.`);
  }
}

export function assertTcgplayerImportSummary(value: unknown): asserts value is TcgplayerImportSummary {
  assertClosedRecord(value, ["fileName", "dateImportedText", "numberOfProducts", "recordedAt"], "import summary");
  assertBoundedText(value.fileName, "import summary fileName", 256);
  assertBoundedText(value.dateImportedText, "import summary dateImportedText", 256);
  assertSafeInteger(value.numberOfProducts, 0, 1_000_000, "import summary numberOfProducts");
  assertTimezoneInstant(value.recordedAt, "import summary recordedAt");
}

export function canonicalManualClaimLeasePolicySnapshotDigest(
  value: Omit<ManualClaimLeasePolicySnapshot, "digest">,
): string {
  const canonical = JSON.stringify({
    policyKey: value.policyKey,
    value: { leaseMs: value.value.leaseMs },
    source: value.source,
    documentId: value.documentId,
    effectiveFrom: value.effectiveFrom,
    effectiveUntil: value.effectiveUntil,
    resolvedAt: value.resolvedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function assertManualClaimLeasePolicySnapshot(value: unknown): asserts value is ManualClaimLeasePolicySnapshot {
  assertClosedRecord(
    value,
    ["policyKey", "value", "source", "documentId", "effectiveFrom", "effectiveUntil", "resolvedAt", "digest"],
    "manual claim lease policy snapshot",
  );
  if (value.policyKey !== "channels.tcgplayer-manual-claim-lease")
    throw new Error("Manual lease policy key is invalid.");
  assertClosedRecord(value.value, ["leaseMs"], "manual claim lease policy snapshot value");
  assertSafeInteger(value.value.leaseMs, 60_000, 7_200_000, "leaseMs");
  if (value.source !== "policy" && value.source !== "fallback")
    throw new Error("Manual lease policy source is invalid.");
  assertTimezoneInstant(value.resolvedAt, "resolvedAt");
  if (value.effectiveUntil !== null) assertTimezoneInstant(value.effectiveUntil, "effectiveUntil");
  if (value.source === "policy") {
    if (typeof value.documentId !== "string" || value.documentId.length === 0)
      throw new Error("Policy documentId is required.");
    assertTimezoneInstant(value.effectiveFrom, "effectiveFrom");
    const resolved = Date.parse(value.resolvedAt);
    if (
      resolved < Date.parse(value.effectiveFrom) ||
      (value.effectiveUntil !== null && resolved >= Date.parse(value.effectiveUntil))
    ) {
      throw new Error("Policy resolution is outside its effective window.");
    }
  } else if (value.documentId !== null || value.effectiveFrom !== null || value.effectiveUntil !== null) {
    throw new Error("Fallback policy snapshots cannot identify a document or effective window.");
  }
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest))
    throw new Error("Policy digest is invalid.");
  const tuple: Omit<ManualClaimLeasePolicySnapshot, "digest"> = {
    policyKey: value.policyKey,
    value: { leaseMs: value.value.leaseMs },
    source: value.source,
    documentId: value.documentId,
    effectiveFrom: value.effectiveFrom,
    effectiveUntil: value.effectiveUntil,
    resolvedAt: value.resolvedAt,
  };
  const digest = value.digest;
  if (digest !== canonicalManualClaimLeasePolicySnapshotDigest(tuple))
    throw new Error("Policy digest does not match its tuple.");
}

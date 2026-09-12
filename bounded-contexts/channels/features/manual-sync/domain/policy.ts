import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { ManualClaimLeasePolicySnapshot } from "../../tcgplayer-csv/domain/contracts";
import {
  assertManualClaimLeasePolicySnapshot,
  canonicalManualClaimLeasePolicySnapshotDigest,
} from "../../tcgplayer-csv/domain/validation";

export type TcgplayerManualClaimLeasePolicyValue = Readonly<{ leaseMs: number }>;

export function decodeTcgplayerManualClaimLeasePolicyValue(raw: JsonValue): TcgplayerManualClaimLeasePolicyValue {
  if (!isJsonObject(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "leaseMs")) {
    throw new Error("TCGplayer manual claim lease policy value must contain only leaseMs.");
  }
  const leaseMs = raw.leaseMs;
  if (typeof leaseMs !== "number" || !Number.isSafeInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 7_200_000) {
    throw new Error("leaseMs must be a safe integer from 60000 through 7200000.");
  }
  return { leaseMs };
}

export const tcgplayerManualClaimLeasePolicy: PolicyDefinition<TcgplayerManualClaimLeasePolicyValue> = definePolicy({
  policyKey: "channels.tcgplayer-manual-claim-lease",
  contextName: "channels",
  schemaSummary: "{ leaseMs: safe integer 60000-7200000 }",
  defaultValue: { leaseMs: 1_800_000 },
  decodeValue: decodeTcgplayerManualClaimLeasePolicyValue,
});

export function freezeManualClaimLeasePolicySnapshot(
  resolved: ResolvedPolicy<TcgplayerManualClaimLeasePolicyValue>,
): ManualClaimLeasePolicySnapshot {
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: decodeTcgplayerManualClaimLeasePolicyValue(resolved.value),
    source: resolved.source,
    documentId: resolved.documentId,
    effectiveFrom: resolved.effectiveFrom,
    effectiveUntil: resolved.effectiveUntil,
    resolvedAt: resolved.resolvedAt,
  };
  const snapshot = { ...tuple, digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple) };
  assertManualClaimLeasePolicySnapshot(snapshot);
  return snapshot;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

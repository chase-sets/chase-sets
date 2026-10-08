import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { manualSyncIngestContract } from "../../manual-sync/domain/contracts";
import { OUTBOUND_CLAIM_LEASE_MIN_MS, OUTBOUND_CLAIM_LEASE_MAX_MS } from "../../outbound-sync/domain/validation";
import { assertClosedRecord } from "../../connections/domain/validation";

// Mirrors assertReserveClaimedOutboundOperationsInput; the source-parity test binds this ceiling.
export const connectorMaxOperations = 1_000_000;

export function connectorReportMaxBytes(policy: ConnectorPolicy): number {
  return policy.maxOperationsPerClaim * 16_384 + 65_536;
}

export const connectorPolicyKeys = [
  "leaseMs",
  "pollWindowSeconds",
  "maxOperationsPerClaim",
  "maxIngestBytes",
  "maxIngestRecords",
] as const;
export type ConnectorPolicy = Readonly<Record<(typeof connectorPolicyKeys)[number], number>>;
export const connectorPolicyDefaults: ConnectorPolicy = Object.freeze({
  leaseMs: 1_800_000,
  pollWindowSeconds: 60,
  maxOperationsPerClaim: 100,
  maxIngestBytes: manualSyncIngestContract.maxBytes,
  maxIngestRecords: manualSyncIngestContract.maxRecords,
});

export function decodeConnectorPolicy(value: unknown): ConnectorPolicy {
  assertClosedRecord(value, connectorPolicyKeys, "connector policy");
  const { leaseMs, pollWindowSeconds, maxOperationsPerClaim, maxIngestBytes, maxIngestRecords } = value;
  integer(leaseMs, OUTBOUND_CLAIM_LEASE_MIN_MS, OUTBOUND_CLAIM_LEASE_MAX_MS);
  integer(pollWindowSeconds, 1, 3600);
  integer(maxOperationsPerClaim, 1, connectorMaxOperations);
  integer(
    maxIngestBytes,
    manualSyncIngestContract.configuredBounds.bytes[0],
    manualSyncIngestContract.configuredBounds.bytes[1],
  );
  integer(
    maxIngestRecords,
    manualSyncIngestContract.configuredBounds.rows[0],
    manualSyncIngestContract.configuredBounds.rows[1],
  );
  return { leaseMs, pollWindowSeconds, maxOperationsPerClaim, maxIngestBytes, maxIngestRecords };
}

export const connectorTransportPolicy = definePolicy({
  policyKey: "channels.connector-transport",
  contextName: "channels",
  schemaSummary: "Closed connector lease, poll window, producer member and manual-ingest bounds.",
  defaultValue: connectorPolicyDefaults,
  decodeValue: decodeConnectorPolicy,
});

function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("invalid-connector-policy");
}

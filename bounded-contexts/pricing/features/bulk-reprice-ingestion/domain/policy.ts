import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * Bulk reprice ingestion's operator-tunable dials (m113), all under
 * ONE policy key so the whole feature's runtime behavior -- including
 * whether it is mounted at all -- resolves from a single row:
 *
 * - `enabled`: the mount gate, following the same policy-boolean-at-route-layer
 *   precedent as marketplace's `behavioral-metrics-policy.ts` -- a
 *   platform-policy boolean is this platform's available pre-launch
 *   surface-gating mechanism.
 * - `chunkSize` / `yieldIntervalMs`: the same throughput dials the chunked-append and terms-session lanes
 *   already use for chunked appends and terms-session batching, sized here
 *   independently because bulk-reprice ingestion also pays a per-wave
 *   inventory-resolution round trip the other bulk callers do not.
 * - `maxActiveJobsPerAccount`: the per-seller concurrent-job cap (AC:
 *   "one active reprice job per account").
 * - `maxRowsPerUpload`: the ceiling a single CSV/API batch may contain,
 *   sized around the 250k-row throughput target.
 * - `createJobRateLimitMax` / `createJobRateLimitWindowMs`: the m110-backed
 *   request-volume guard for starting jobs. Keeping these dials in this
 *   feature's one policy document makes the whole on-ramp removable and
 *   lets operators revise the limit without a deploy.
 */
export type BulkRepriceIngestionPolicyValue = Readonly<{
  enabled: boolean;
  chunkSize: number;
  yieldIntervalMs: number;
  maxActiveJobsPerAccount: number;
  maxRowsPerUpload: number;
  createJobRateLimitMax: number;
  createJobRateLimitWindowMs: number;
}>;

export const BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE: BulkRepriceIngestionPolicyValue = {
  // Pre-launch gated surfaces default closed; an active policy document is
  // the deliberate operator action that exposes this removable on-ramp.
  enabled: false,
  chunkSize: 200,
  yieldIntervalMs: 25,
  maxActiveJobsPerAccount: 1,
  maxRowsPerUpload: 250_000,
  createJobRateLimitMax: 10,
  createJobRateLimitWindowMs: 60_000,
};

export class BulkRepriceIngestionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkRepriceIngestionPolicyError";
  }
}

function decodeBoundedInteger(raw: unknown, field: string, min: number, max: number): number {
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new BulkRepriceIngestionPolicyError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return numeric;
}

export function decodeBulkRepriceIngestionPolicyValue(raw: JsonValue): BulkRepriceIngestionPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BulkRepriceIngestionPolicyError("Bulk reprice ingestion policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    throw new BulkRepriceIngestionPolicyError("enabled must be a boolean.");
  }

  return {
    enabled: record.enabled,
    chunkSize: decodeBoundedInteger(record.chunkSize, "chunkSize", 1, 500),
    yieldIntervalMs: decodeBoundedInteger(record.yieldIntervalMs, "yieldIntervalMs", 0, 60_000),
    maxActiveJobsPerAccount: decodeBoundedInteger(record.maxActiveJobsPerAccount, "maxActiveJobsPerAccount", 1, 1),
    maxRowsPerUpload: decodeBoundedInteger(record.maxRowsPerUpload, "maxRowsPerUpload", 1, 1_000_000),
    // Additive defaults keep already-authored policy documents valid while
    // the new m110 rate-limit dials roll out.
    createJobRateLimitMax: decodeBoundedInteger(
      record.createJobRateLimitMax ?? BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE.createJobRateLimitMax,
      "createJobRateLimitMax",
      1,
      1_000,
    ),
    createJobRateLimitWindowMs: decodeBoundedInteger(
      record.createJobRateLimitWindowMs ?? BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE.createJobRateLimitWindowMs,
      "createJobRateLimitWindowMs",
      1_000,
      86_400_000,
    ),
  };
}

export const bulkRepriceIngestionPolicy: PolicyDefinition<BulkRepriceIngestionPolicyValue> = definePolicy({
  policyKey: "pricing.bulk-reprice-ingestion",
  contextName: "pricing",
  schemaSummary:
    "{ enabled: boolean, chunkSize: integer 1-500, yieldIntervalMs: integer 0-60000, maxActiveJobsPerAccount: integer 1, maxRowsPerUpload: integer 1-1000000, createJobRateLimitMax: integer 1-1000, createJobRateLimitWindowMs: integer 1000-86400000 }",
  defaultValue: BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
  decodeValue: decodeBulkRepriceIngestionPolicyValue,
});

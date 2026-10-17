import { OutboundSyncError } from "./contracts";
import { assertRfc3339Instant } from "../../connections/domain/validation";
import { manualSyncIngestContract } from "../../manual-sync/domain/contracts";

export const liveExportOperationKind = "tcgplayer-live-export" as const;
export const liveExportHeaderSha256 = "bc90276b42c802563f2cc025d4e87b9123a3fdb4b84d85e7ae8a46db64121bcc";
export const liveExportBounds = Object.freeze({
  fetchTimeoutMs: 60_000,
  postTimeoutMs: 10_000,
  reportTimeoutMs: 10_000,
  budgetMs: 110_000,
});
export const liveExportUnknownReasons = [
  "authority-unavailable",
  "session-lost",
  "download-unproven",
  "raw-unreadable",
  "parse-refused",
  "cap-exceeded",
  "admission-ambiguous",
  "budget-exceeded",
] as const;
export const liveExportAbandonReasons = ["released", "claimant-cancelled"] as const;

export type LiveExportPayload = Readonly<{
  kind: "live-export";
  version: 1;
  connectionId: string;
  exportId: string;
  scheduleGeneration: number;
  parserProfile: Readonly<{ id: "tcgplayer-live-export/v1"; headerSha256: string }>;
  limits: Readonly<{ maxBytes: number; maxRecords: number }>;
  bounds: Readonly<{ fetchTimeoutMs: number; postTimeoutMs: number; reportTimeoutMs: number; budgetMs: number }>;
}>;
export type ClaimedLiveExportOutcome = Readonly<{
  operationKind: typeof liveExportOperationKind;
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  exportId: string;
  payloadDigest: string;
  outcome:
    | Readonly<{
        kind: "live-export-complete";
        exportId: string;
        fileSha256: string;
        capturedAt: string;
        parsedRowCount: number;
        externalReference: string;
      }>
    | Readonly<{ kind: "live-export-unknown"; exportId: string; reason: (typeof liveExportUnknownReasons)[number] }>
    | Readonly<{ kind: "abandoned"; reason: (typeof liveExportAbandonReasons)[number] }>;
}>;

export function liveExportFitsLease(budgetMs: number, leaseMs: number): boolean {
  return Number.isSafeInteger(budgetMs) && Number.isFinite(leaseMs) && budgetMs + 30_000 < leaseMs;
}

/** Browser-safe closed codec; the server additionally binds deterministic identities. */
export function assertLiveExportPayloadStructure(value: unknown, leaseMs?: number): asserts value is LiveExportPayload {
  const row = closed(value, [
    "kind",
    "version",
    "connectionId",
    "exportId",
    "scheduleGeneration",
    "parserProfile",
    "limits",
    "bounds",
  ]);
  if (row.kind !== "live-export" || row.version !== 1) invalid("kind/version");
  text(row.connectionId, "connectionId");
  exportId(row.exportId);
  integer(row.scheduleGeneration, 1, Number.MAX_SAFE_INTEGER, "scheduleGeneration");
  const profile = closed(row.parserProfile, ["id", "headerSha256"]);
  if (profile.id !== "tcgplayer-live-export/v1" || profile.headerSha256 !== liveExportHeaderSha256)
    invalid("parserProfile");
  const limits = closed(row.limits, ["maxBytes", "maxRecords"]);
  integer(
    limits.maxBytes,
    manualSyncIngestContract.configuredBounds.bytes[0]!,
    manualSyncIngestContract.configuredBounds.bytes[1]!,
    "maxBytes",
  );
  integer(
    limits.maxRecords,
    manualSyncIngestContract.configuredBounds.rows[0]!,
    manualSyncIngestContract.configuredBounds.rows[1]!,
    "maxRecords",
  );
  const bounds = closed(row.bounds, ["fetchTimeoutMs", "postTimeoutMs", "reportTimeoutMs", "budgetMs"]);
  integer(bounds.fetchTimeoutMs, 1, liveExportBounds.fetchTimeoutMs, "fetchTimeoutMs");
  integer(bounds.postTimeoutMs, 1, liveExportBounds.postTimeoutMs, "postTimeoutMs");
  integer(bounds.reportTimeoutMs, 1, liveExportBounds.reportTimeoutMs, "reportTimeoutMs");
  integer(bounds.budgetMs, 1, 600_000, "budgetMs");
  if (bounds.budgetMs !== bounds.fetchTimeoutMs + bounds.postTimeoutMs + bounds.reportTimeoutMs + 30_000)
    invalid("budgetMs");
  if (leaseMs !== undefined && !liveExportFitsLease(bounds.budgetMs, leaseMs)) invalid("leaseMs");
}

export function isClaimedLiveExportOutcome(value: object): value is ClaimedLiveExportOutcome {
  return "operationKind" in value && value.operationKind === liveExportOperationKind;
}

export function assertClaimedLiveExportOutcome(value: unknown): asserts value is ClaimedLiveExportOutcome {
  const row = closed(value, [
    "operationKind",
    "operationId",
    "attemptId",
    "claimGeneration",
    "exportId",
    "payloadDigest",
    "outcome",
  ]);
  if (row.operationKind !== liveExportOperationKind) invalid("operationKind");
  text(row.operationId, "operationId");
  text(row.attemptId, "attemptId");
  integer(row.claimGeneration, 1, Number.MAX_SAFE_INTEGER, "claimGeneration");
  exportId(row.exportId);
  digest(row.payloadDigest, "payloadDigest");
  assertLiveExportOutcomeBody(row.outcome);
  if (row.outcome.kind !== "abandoned" && row.outcome.exportId !== row.exportId) invalid("exportId binding");
}

export function assertLiveExportOutcomeBody(value: unknown): asserts value is ClaimedLiveExportOutcome["outcome"] {
  if (!value || typeof value !== "object" || !("kind" in value)) invalid("outcome");
  if (value.kind === "abandoned") {
    const row = closed(value, ["kind", "reason"]);
    if (!liveExportAbandonReasons.includes(row.reason as never)) invalid("abandoned reason");
  } else if (value.kind === "live-export-unknown") {
    const row = closed(value, ["kind", "exportId", "reason"]);
    exportId(row.exportId);
    if (!liveExportUnknownReasons.includes(row.reason as never)) invalid("unknown reason");
  } else if (value.kind === "live-export-complete") {
    const row = closed(value, ["kind", "exportId", "fileSha256", "capturedAt", "parsedRowCount", "externalReference"]);
    exportId(row.exportId);
    digest(row.fileSha256, "fileSha256");
    assertRfc3339Instant(row.capturedAt, "capturedAt");
    integer(row.parsedRowCount, 0, manualSyncIngestContract.configuredBounds.rows[1]!, "parsedRowCount");
    text(row.externalReference, "externalReference");
  } else invalid("outcome kind");
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid("closed fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(label);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) invalid(label);
}
function exportId(value: unknown): void {
  if (typeof value !== "string" || !/^cxpl_[a-f0-9]{40}$/.test(value)) invalid("exportId");
}
function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(label);
}
function invalid(variable: string): never {
  throw new OutboundSyncError("invalid-input", `Invalid live-export ${variable}.`);
}

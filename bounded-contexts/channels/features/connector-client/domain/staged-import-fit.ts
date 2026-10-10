import { closedRecord, connectorValue } from "./extension-records";
import { StagedImportDispatchError } from "../../connector-feed/domain/staged-import-dispatch-policy";

export type StagedImportCapturePlan = Readonly<{
  schemaVersion: 1;
  source: "capture-derived";
  captureDigest: string;
  complete: true;
  polling: false;
  connectionId: string;
  pairingId: string;
  reservationId: string;
  executorKey: string;
  membershipDigest: string;
  batchDigest: string;
  composedRows: number;
  requests: readonly Readonly<{ requestId: string; maximumDurationMs: number }>[];
  platformReadMs: number;
  parsingMs: number;
  reportMs: number;
}>;

export function decodeStagedImportCapturePlan(input: unknown): StagedImportCapturePlan {
  try {
    const row = closedRecord(input, [
      "schemaVersion",
      "source",
      "captureDigest",
      "complete",
      "polling",
      "connectionId",
      "pairingId",
      "reservationId",
      "executorKey",
      "membershipDigest",
      "batchDigest",
      "composedRows",
      "requests",
      "platformReadMs",
      "parsingMs",
      "reportMs",
    ]);
    if (row.schemaVersion !== 1 || row.source !== "capture-derived" || row.complete !== true || row.polling !== false)
      throw new Error();
    for (const key of ["connectionId", "pairingId", "reservationId", "executorKey"]) connectorValue(row[key]);
    for (const key of ["captureDigest", "membershipDigest", "batchDigest"])
      if (typeof row[key] !== "string" || !/^[a-f0-9]{64}$/.test(row[key])) throw new Error();
    if (!Number.isSafeInteger(row.composedRows) || Number(row.composedRows) < 0 || Number(row.composedRows) > 500)
      throw new Error();
    if (
      !Array.isArray(row.requests) ||
      row.requests.length > 4096 ||
      (Number(row.composedRows) > 0 && row.requests.length === 0) ||
      (row.composedRows === 0 && row.requests.length !== 0)
    )
      throw new Error();
    const ids = new Set<string>();
    for (const request of row.requests) {
      const hop = closedRecord(request, ["requestId", "maximumDurationMs"]);
      const id = connectorValue(hop.requestId);
      if (ids.has(id)) throw new Error();
      ids.add(id);
      positiveDuration(hop.maximumDurationMs);
    }
    for (const key of ["platformReadMs", "parsingMs", "reportMs"]) positiveDuration(row[key]);
    return structuredClone(row) as StagedImportCapturePlan;
  } catch {
    throw new StagedImportDispatchError("staged-import-plan-unavailable");
  }
}

function positiveDuration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 600000)
    throw new StagedImportDispatchError("staged-import-fit-refused");
}

export function stagedImportProtocolCost(
  intervalMs: number,
  durations: readonly number[],
  initialWaitMs: number,
  overheadMs: number,
): number {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60000 ||
    intervalMs > 600000 ||
    !Number.isFinite(initialWaitMs) ||
    initialWaitMs < 0 ||
    !Number.isSafeInteger(overheadMs) ||
    overheadMs < 0 ||
    durations.length > 4096
  )
    throw new StagedImportDispatchError("staged-import-fit-refused");
  durations.forEach(positiveDuration);
  if (!durations.length) return 0;
  const cost =
    initialWaitMs +
    durations.reduce(
      (sum, duration, index) => sum + (index === durations.length - 1 ? duration : Math.max(intervalMs, duration)),
      0,
    ) +
    overheadMs;
  if (!Number.isFinite(cost) || cost > Number.MAX_SAFE_INTEGER)
    throw new StagedImportDispatchError("staged-import-fit-refused");
  return cost;
}

export function assertStagedImportFit(
  input: Readonly<{
    costMs: number;
    remainingMs: number;
    dispatchDeadlineMs: number;
    now: number;
    leaseExpiresAt: number;
    policyRemainingMs: number;
  }>,
): void {
  if (
    !Number.isFinite(input.costMs) ||
    input.costMs < 0 ||
    !Number.isFinite(input.remainingMs) ||
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.leaseExpiresAt) ||
    !Number.isSafeInteger(input.dispatchDeadlineMs) ||
    input.dispatchDeadlineMs < 1000 ||
    input.dispatchDeadlineMs > 600000 ||
    input.costMs > input.remainingMs ||
    input.costMs > input.dispatchDeadlineMs ||
    input.now + input.dispatchDeadlineMs + 30000 >= input.leaseExpiresAt ||
    !(input.costMs < input.policyRemainingMs)
  )
    throw new StagedImportDispatchError("staged-import-fit-refused");
}

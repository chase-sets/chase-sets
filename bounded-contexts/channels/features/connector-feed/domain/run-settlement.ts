import type { ClaimedReservationRunSettlement } from "../../outbound-sync/domain/contracts";
import { ChannelConnectionError } from "../../connections/domain/contracts";
import { assertClosedRecord, assertRfc3339Instant } from "../../connections/domain/validation";

export type ConnectorRunSettlement = Omit<ClaimedReservationRunSettlement, "context">;

export function assertConnectorRunSettlement(value: unknown): asserts value is ConnectorRunSettlement {
  assertClosedRecord(
    value,
    Object.keys({
      runId: true,
      expectedRunRevision: true,
      fromState: true,
      toState: true,
      verificationSnapshotId: true,
      verificationSnapshotGeneration: true,
      uploadAttemptedAt: true,
      uploadFileName: true,
      importSummary: true,
    } satisfies Record<keyof ConnectorRunSettlement, true>),
    "connector run settlement",
  );
  text(value.runId);
  integer(value.expectedRunRevision, 0);
  const fromStates = { composed: true, claimed: true, "awaiting-verification": true } satisfies Record<
    ConnectorRunSettlement["fromState"],
    true
  >;
  const toStates = {
    applied: true,
    "validation-rejected": true,
    "application-unknown": true,
    superseded: true,
    "stale-basis": true,
    abandoned: true,
  } satisfies Record<ConnectorRunSettlement["toState"], true>;
  if (
    typeof value.fromState !== "string" ||
    !Object.hasOwn(fromStates, value.fromState) ||
    typeof value.toState !== "string" ||
    !Object.hasOwn(toStates, value.toState)
  )
    invalid();
  if (value.verificationSnapshotId !== null) text(value.verificationSnapshotId);
  if (value.verificationSnapshotGeneration !== null) integer(value.verificationSnapshotGeneration, 1);
  if (value.uploadAttemptedAt !== null) {
    text(value.uploadAttemptedAt);
    assertRfc3339Instant(value.uploadAttemptedAt);
  }
  if (value.uploadFileName !== null) text(value.uploadFileName);
  if (value.importSummary !== null) {
    assertClosedRecord(
      value.importSummary,
      Object.keys({ fileName: true, dateImportedText: true, numberOfProducts: true, recordedAt: true } satisfies Record<
        keyof NonNullable<ConnectorRunSettlement["importSummary"]>,
        true
      >),
      "connector import summary",
    );
    text(value.importSummary.fileName);
    text(value.importSummary.dateImportedText);
    integer(value.importSummary.numberOfProducts, 0);
    text(value.importSummary.recordedAt);
    assertRfc3339Instant(value.importSummary.recordedAt);
  }
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) invalid();
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) invalid();
  }
}
function integer(value: unknown, min: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid();
}
function invalid(): never {
  throw new ChannelConnectionError("invalid-input", "Invalid connector run settlement.");
}

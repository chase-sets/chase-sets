import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { EventAuditContext, EventStoreContext, EventTraceContext } from "@chase-sets/event-core/storage";
import type { ClaimedOperationOutcome, ClaimedReservationRunSettlement } from "../../outbound-sync/domain/contracts";
import { assertClaimedOperationOutcome } from "../../outbound-sync/domain/validation";
import { assertClosedRecord, assertRfc3339Instant } from "../../connections/domain/validation";
import {
  assertDerivedTcgplayerSnapshot,
  type DerivedTcgplayerSnapshot,
} from "../../tcgplayer-csv/domain/derived-snapshot";
import { connectorMaxOperations, type ConnectorPolicy } from "./policy";

export const connectorInboundKinds = ["order", "export"] as const;
export type ConnectorInboundKind = (typeof connectorInboundKinds)[number];
export const connectorInboundRetentionClasses = {
  order: { retentionClass: "order-observation", days: 90 },
  export: { retentionClass: "inventory-snapshot", days: 7 },
} as const;
export type ConnectorInbound = Readonly<{ externalReference: string }> &
  (
    | Readonly<{ inboundKind: "order"; payload: Readonly<{ version: 1; records: readonly JsonObject[] }> }>
    | Readonly<{ inboundKind: "export"; payload: DerivedTcgplayerSnapshot }>
  );
export type ConnectorReport = Readonly<{
  reservationId: string;
  outcomes: readonly ClaimedOperationOutcome[];
  runSettlement?: ClaimedReservationRunSettlement;
}>;
export class ConnectorTransportError extends Error {
  constructor(readonly code: "invalid-input" | "policy-unavailable") {
    super(code);
  }
}

export function assertConnectorInbound(value: unknown, policy: ConnectorPolicy): asserts value is ConnectorInbound {
  assertClosedRecord(value, ["inboundKind", "externalReference", "payload"], "connector inbound");
  if (
    typeof value.externalReference !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value.externalReference)
  )
    invalid();
  if (value.inboundKind === "export") {
    assertDerivedTcgplayerSnapshot(value.payload, {
      maxBytes: policy.maxIngestBytes,
      maxRecords: policy.maxIngestRecords,
    });
  } else if (value.inboundKind === "order") {
    assertClosedRecord(value.payload, ["version", "records"], "opaque order payload");
    if (
      value.payload.version !== 1 ||
      !Array.isArray(value.payload.records) ||
      value.payload.records.length < 1 ||
      value.payload.records.length > policy.maxIngestRecords
    )
      invalid();
    for (const record of value.payload.records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) invalid();
      assertOpaqueJson(record, policy.maxIngestBytes);
    }
  } else invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > policy.maxIngestBytes) invalid();
}

export function assertConnectorReport(value: unknown): asserts value is ConnectorReport {
  assertClosedRecord(value, ["reservationId", "outcomes", "runSettlement"], "connector report");
  text(value.reservationId);
  if (!Array.isArray(value.outcomes) || value.outcomes.length > connectorMaxOperations) invalid();
  for (const outcome of value.outcomes) {
    assertClaimedOperationOutcome(outcome);
    assertOpaqueJson(outcome, 16_384);
  }
  if (Object.hasOwn(value, "runSettlement")) assertSettlement(value.runSettlement);
}

function assertSettlement(value: unknown): asserts value is ClaimedReservationRunSettlement {
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
      context: true,
    } satisfies Record<keyof ClaimedReservationRunSettlement, true>),
    "run settlement",
  );
  text(value.runId);
  integer(value.expectedRunRevision, 0);
  const fromStates = { composed: true, claimed: true, "awaiting-verification": true } satisfies Record<
    ClaimedReservationRunSettlement["fromState"],
    true
  >;
  const toStates = {
    applied: true,
    "validation-rejected": true,
    "application-unknown": true,
    superseded: true,
    "stale-basis": true,
    abandoned: true,
  } satisfies Record<ClaimedReservationRunSettlement["toState"], true>;
  if (
    typeof value.fromState !== "string" ||
    !Object.hasOwn(fromStates, value.fromState) ||
    typeof value.toState !== "string" ||
    !Object.hasOwn(toStates, value.toState)
  )
    invalid();
  if (value.verificationSnapshotId !== null) text(value.verificationSnapshotId);
  if (value.verificationSnapshotGeneration !== null) integer(value.verificationSnapshotGeneration, 1);
  if (value.uploadAttemptedAt !== null) assertRfc3339Instant(value.uploadAttemptedAt);
  if (value.uploadFileName !== null) text(value.uploadFileName);
  if (value.importSummary !== null) {
    assertClosedRecord(
      value.importSummary,
      Object.keys({ fileName: true, dateImportedText: true, numberOfProducts: true, recordedAt: true } satisfies Record<
        keyof NonNullable<ClaimedReservationRunSettlement["importSummary"]>,
        true
      >),
      "import summary",
    );
    text(value.importSummary.fileName);
    text(value.importSummary.dateImportedText);
    integer(value.importSummary.numberOfProducts, 0);
    assertRfc3339Instant(value.importSummary.recordedAt);
  }
  if (value.context !== null) {
    assertClosedRecord(
      value.context,
      Object.keys({ tenantId: true, audit: true, trace: true } satisfies Record<keyof EventStoreContext, true>),
      "settlement context",
    );
    text(value.context.tenantId);
    assertClosedRecord(
      value.context.audit,
      Object.keys({ performedByUserId: true, forAccountId: true } satisfies Record<keyof EventAuditContext, true>),
      "settlement audit",
    );
    text(value.context.audit.performedByUserId);
    text(value.context.audit.forAccountId);
    if (Object.hasOwn(value.context, "trace")) {
      assertClosedRecord(
        value.context.trace,
        Object.keys({ traceId: true, spanId: true, parentSpanId: true, traceState: true } satisfies Record<
          keyof EventTraceContext,
          true
        >),
        "settlement trace",
      );
      for (const field of Object.values(value.context.trace)) text(field);
    }
  }
}

function assertOpaqueJson(value: unknown, maxBytes: number, depth = 0): asserts value is JsonValue {
  if (depth > 32) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > maxBytes) invalid();
    scalar(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertOpaqueJson(item, maxBytes, depth + 1);
    return;
  }
  if (typeof value !== "object") invalid();
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 512 || ["__proto__", "prototype", "constructor"].includes(key)) invalid();
    scalar(key);
    assertOpaqueJson(item, maxBytes, depth + 1);
  }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) invalid();
  scalar(value);
}
function scalar(value: string): void {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) invalid();
  }
}
function integer(value: unknown, min: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid();
}
function invalid(): never {
  throw new ConnectorTransportError("invalid-input");
}

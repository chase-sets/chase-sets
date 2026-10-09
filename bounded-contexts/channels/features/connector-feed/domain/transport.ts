import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import {
  connectorClaimCapabilities,
  type ClaimedSubjectOutcome,
  type ConnectorClaimCapability,
} from "../../outbound-sync/domain/contracts";
import { assertClaimedSubjectOutcome } from "../../outbound-sync/domain/validation";
import { assertClosedRecord } from "../../connections/domain/validation";
import { assertConnectorRunSettlement, type ConnectorRunSettlement } from "./run-settlement";
import {
  assertDerivedTcgplayerSnapshot,
  type DerivedTcgplayerSnapshot,
} from "../../tcgplayer-csv/domain/derived-snapshot";
import { connectorMaxOperations, type ConnectorPolicy } from "./policy";

export const connectorInboundKinds = ["order", "export"] as const;
export type ConnectorInboundKind = (typeof connectorInboundKinds)[number];
export type ConnectorInbound = Readonly<{ externalReference: string }> &
  (
    | Readonly<{ inboundKind: "order"; payload: Readonly<{ version: 1; records: readonly JsonObject[] }> }>
    | Readonly<{ inboundKind: "export"; payload: DerivedTcgplayerSnapshot }>
  );
export type ConnectorClaim = Readonly<{ capabilities?: readonly ConnectorClaimCapability[] }>;
export type ConnectorReport = Readonly<{
  reservationId: string;
  outcomes: readonly ClaimedSubjectOutcome[];
  runSettlement?: ConnectorRunSettlement;
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

/** An empty claim is incapable; only a declared capability admits connection-subject pull members. */
export function assertConnectorClaim(value: unknown): asserts value is ConnectorClaim {
  assertClosedRecord(value, ["capabilities"], "connector claim");
  if (!Object.hasOwn(value, "capabilities")) return;
  const capabilities = value.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > connectorClaimCapabilities.length ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => !connectorClaimCapabilities.includes(capability))
  )
    invalid();
}

export function assertConnectorReport(value: unknown): asserts value is ConnectorReport {
  assertClosedRecord(value, ["reservationId", "outcomes", "runSettlement"], "connector report");
  text(value.reservationId);
  if (!Array.isArray(value.outcomes) || value.outcomes.length > connectorMaxOperations) invalid();
  for (const outcome of value.outcomes) {
    assertClaimedSubjectOutcome(outcome);
    assertOpaqueJson(outcome, 16_384);
  }
  if (Object.hasOwn(value, "runSettlement")) assertConnectorRunSettlement(value.runSettlement);
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
function invalid(): never {
  throw new ConnectorTransportError("invalid-input");
}

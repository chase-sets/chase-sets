import {
  ChannelHealthError,
  channelHealthReasons,
  channelHealthSources,
  channelHealthStates,
  type ChannelHealthChanged,
  type ChannelHealthObservation,
  type ChannelHealthPolicy,
  type ChannelHealthQuery,
  type ChannelHealthRead,
  type ChannelHealthReasonGeneration,
  type ChannelHealthSnapshot,
} from "./contracts";

export function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) invalid();
  return value;
}
function count(value: unknown): number {
  if (value === 0) return 0;
  return integer(value);
}
export function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) invalid();
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
export function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return value;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
export function decodeChannelHealthPolicy(value: unknown): ChannelHealthPolicy {
  const r = closed(value, ["windowSeconds", "consecutiveFailureThreshold", "failureBudgetCount"]);
  return {
    windowSeconds: integer(r.windowSeconds, 2_592_000),
    consecutiveFailureThreshold: integer(r.consecutiveFailureThreshold, 2_592_000),
    failureBudgetCount: integer(r.failureBudgetCount, 2_592_000),
  };
}
export function decodeChannelHealthObservation(value: unknown): ChannelHealthObservation {
  const r = closed(value, [
    "schemaVersion",
    "sourceKind",
    "sourceWorkId",
    "sourceAttempt",
    "resultOrdinal",
    "policyRevision",
    "evaluationGeneration",
    "connectionId",
    "reasonCode",
    "fingerprint",
    "outcome",
    "occurredAt",
  ]);
  const sourceKind = member(r.sourceKind, channelHealthSources);
  const reasonCode = member(r.reasonCode, channelHealthReasons);
  if ((sourceKind === "channel-reconciliation" ? "drift" : sourceKind) !== reasonCode) invalid();
  return {
    schemaVersion: member(r.schemaVersion, ["ChannelHealthObservation/v1"]),
    sourceKind,
    sourceWorkId: digest(r.sourceWorkId),
    sourceAttempt: integer(r.sourceAttempt),
    resultOrdinal: integer(r.resultOrdinal),
    policyRevision: digest(r.policyRevision),
    evaluationGeneration: integer(r.evaluationGeneration),
    connectionId: identity(r.connectionId),
    reasonCode,
    fingerprint: digest(r.fingerprint),
    outcome: member(r.outcome, ["success", "failure"]),
    occurredAt: instant(r.occurredAt),
  };
}
export function decodeChannelHealthQuery(value: unknown): ChannelHealthQuery {
  const r = closed(value, ["connectionId", "accountId"]);
  return { connectionId: identity(r.connectionId), accountId: identity(r.accountId) };
}
export function decodeReasonGeneration(value: unknown): ChannelHealthReasonGeneration {
  const r = closed(value, [
    "reasonCode",
    "generation",
    "fingerprint",
    "state",
    "consecutiveFailures",
    "trailingFailures",
    "opening",
    "lastOccurredAt",
  ]);
  const opening = closed(r.opening, ["sourceWorkId", "sourceAttempt", "occurredAt"]);
  return {
    reasonCode: member(r.reasonCode, channelHealthReasons),
    generation: integer(r.generation),
    fingerprint: digest(r.fingerprint),
    state: member(r.state, ["closed", "degraded", "failing"]),
    consecutiveFailures: count(r.consecutiveFailures),
    trailingFailures: count(r.trailingFailures),
    opening: {
      sourceWorkId: digest(opening.sourceWorkId),
      sourceAttempt: integer(opening.sourceAttempt),
      occurredAt: instant(opening.occurredAt),
    },
    lastOccurredAt: instant(r.lastOccurredAt),
  };
}
export function decodeChannelHealthSnapshot(value: unknown): ChannelHealthSnapshot {
  const r = closed(value, ["policyRevision", "evaluationGeneration", "state", "reasons", "observedAt"]);
  if (!Array.isArray(r.reasons) || r.reasons.length > channelHealthReasons.length) invalid();
  const reasons = r.reasons.map(decodeReasonGeneration);
  if (new Set(reasons.map((reason) => reason.reasonCode)).size !== reasons.length) invalid();
  return {
    policyRevision: digest(r.policyRevision),
    evaluationGeneration: integer(r.evaluationGeneration),
    state: member(r.state, channelHealthStates),
    reasons,
    observedAt: r.observedAt === null ? null : instant(r.observedAt),
  };
}
export function decodeChannelHealthRead(value: unknown): ChannelHealthRead {
  const r = closed(value, [
    "schemaVersion",
    "connection",
    "health",
    "policyAvailable",
    "systemPaused",
    "outboundPublicationAllowed",
    "pollingAllowed",
    "verifiedInboundSaleAllowed",
  ]);
  const connection = closed(r.connection, ["connectionId", "accountId", "status"]);
  return {
    schemaVersion: member(r.schemaVersion, ["ChannelHealthRead/v1"]),
    connection: {
      connectionId: identity(connection.connectionId),
      accountId: identity(connection.accountId),
      status:
        connection.status === null
          ? null
          : member(connection.status, ["pending-setup", "active", "paused", "disconnected"]),
    },
    health: decodeChannelHealthSnapshot(r.health),
    policyAvailable: boolean(r.policyAvailable),
    systemPaused: boolean(r.systemPaused),
    outboundPublicationAllowed: boolean(r.outboundPublicationAllowed),
    pollingAllowed: boolean(r.pollingAllowed),
    verifiedInboundSaleAllowed: boolean(r.verifiedInboundSaleAllowed),
  };
}
export function decodeChannelHealthChanged(value: unknown): ChannelHealthChanged {
  const r = closed(value, ["schemaVersion", "connection", "reasonCode", "generation", "diagnosticCode", "observedAt"]);
  return {
    schemaVersion: member(r.schemaVersion, ["ChannelHealthChanged/v1"]),
    connection: decodeChannelHealthQuery(r.connection),
    reasonCode: member(r.reasonCode, channelHealthReasons),
    generation: integer(r.generation),
    diagnosticCode: member(r.diagnosticCode, ["reason-opened", "reason-failing", "reason-closed"]),
    observedAt: instant(r.observedAt),
  };
}
function invalid(): never {
  throw new ChannelHealthError("invalid-health-contract");
}

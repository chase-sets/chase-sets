import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  compareGlobalPosition,
  parseGlobalPosition,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { readGapSafeEventStoreHead, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { isPolicyKey } from "./define-policy";
import { normalizePolicyEffectiveWindow, type PolicyDocumentStatus } from "./domain";
import { POLICY_DOCUMENT_STREAM_PREFIX, policyDocumentIdFromStreamId } from "./policy-document-stream";

const POLICY_HISTORY_PAGE_SIZE = 500;
const POLICY_EVENT_TYPES = ["platform-policy.document.created", "platform-policy.document.revised"] as const;

export class PolicyHistoryReaderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PolicyHistoryReaderError";
  }
}

export type PolicyHistoryRecord = Readonly<{
  eventId: string;
  eventType: (typeof POLICY_EVENT_TYPES)[number];
  policyKey: string;
  documentId: string;
  streamVersion: number;
  globalPosition: GlobalPosition;
  recordedAt: string;
  status: PolicyDocumentStatus;
  value: JsonValue;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type PolicyHistoryContinuation = Readonly<{
  policyKey: string;
  horizon: GlobalPosition;
  afterGlobalPosition: GlobalPosition;
}>;

export type PolicyHistoryStart = Readonly<{
  policyKey: string;
  horizon: GlobalPosition;
  continuation: PolicyHistoryContinuation;
}>;

export type PolicyHistoryPage = Readonly<{
  records: readonly PolicyHistoryRecord[];
  horizon: GlobalPosition;
  continuation: PolicyHistoryContinuation;
  complete: boolean;
}>;

export type PolicyHistoryReader = Readonly<{
  start: (policyKeyOrInput: string | Readonly<{ policyKey: string }>) => Promise<PolicyHistoryStart>;
  readPage: (
    input:
      | PolicyHistoryContinuation
      | Readonly<{ policyKey: string; horizon: GlobalPosition; afterGlobalPosition?: GlobalPosition }>,
  ) => Promise<PolicyHistoryPage>;
}>;

export type PolicyHistoryReaderDeps = Readonly<{
  eventStore: EventStore;
  pool: PgTransactionalPool;
}>;

export function createPolicyHistoryReader(deps: PolicyHistoryReaderDeps): PolicyHistoryReader {
  return {
    start: async (policyKeyOrInput) => {
      const policyKey = typeof policyKeyOrInput === "string" ? policyKeyOrInput : policyKeyOrInput.policyKey;
      assertPolicyKey(policyKey);
      const horizon = await readGapSafeEventStoreHead(deps.pool);
      return {
        policyKey,
        horizon,
        continuation: { policyKey, horizon, afterGlobalPosition: "0" as GlobalPosition },
      };
    },
    readPage: async (input) => {
      const policyKey = input.policyKey;
      assertPolicyKey(policyKey);
      const horizon = parsePosition(input.horizon, "horizon");
      const afterGlobalPosition = parsePosition(input.afterGlobalPosition ?? "0", "continuation");
      if (compareGlobalPosition(afterGlobalPosition, horizon) > 0) {
        throw new PolicyHistoryReaderError("Policy history continuation is outside its fixed horizon.");
      }

      const rawEvents = await deps.eventStore.readAll({
        afterGlobalPosition,
        atOrBeforeGlobalPosition: horizon,
        eventTypes: POLICY_EVENT_TYPES,
        streamPrefixes: [POLICY_DOCUMENT_STREAM_PREFIX],
        limit: POLICY_HISTORY_PAGE_SIZE,
      });

      let lastRawPosition = afterGlobalPosition;
      const records: PolicyHistoryRecord[] = [];
      for (const event of rawEvents) {
        const position = parsePosition(event.globalPosition, "event global position");
        if (compareGlobalPosition(position, lastRawPosition) <= 0 || compareGlobalPosition(position, horizon) > 0) {
          throw new PolicyHistoryReaderError("Policy history source returned a non-advancing or out-of-horizon page.");
        }
        lastRawPosition = position;
        const identity = decodePolicyHistoryEvent(event, false);
        if (identity.policyKey === policyKey) {
          records.push(decodePolicyHistoryEvent(event, true) as PolicyHistoryRecord);
        }
      }

      const continuation = { policyKey, horizon, afterGlobalPosition: lastRawPosition };
      return {
        records,
        horizon,
        continuation,
        complete: rawEvents.length < POLICY_HISTORY_PAGE_SIZE,
      };
    },
  };
}

export const createPolicyRevisionTimelineReader = createPolicyHistoryReader;

function assertPolicyKey(policyKey: string): void {
  if (typeof policyKey !== "string" || !isPolicyKey(policyKey)) {
    throw new PolicyHistoryReaderError(`Invalid policy key '${String(policyKey)}'.`);
  }
}

function parsePosition(value: unknown, label: string): GlobalPosition {
  if (typeof value !== "string") {
    throw new PolicyHistoryReaderError(`Policy history ${label} must be a canonical global position.`);
  }
  try {
    return parseGlobalPosition(value);
  } catch {
    throw new PolicyHistoryReaderError(`Policy history ${label} must be a canonical global position.`);
  }
}

function decodePolicyHistoryEvent(
  event: StoredEvent,
  full = true,
): PolicyHistoryRecord | Readonly<{ policyKey: string }> {
  const documentId = policyDocumentIdFromStreamId(event.streamId);
  if (documentId === null) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid document stream identity.");
  }
  if (typeof event.eventId !== "string" || event.eventId.length === 0) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid event identity.");
  }
  if (event.eventType !== POLICY_EVENT_TYPES[0] && event.eventType !== POLICY_EVENT_TYPES[1]) {
    throw new PolicyHistoryReaderError("Policy history event has an unsupported event type.");
  }
  if (!Number.isInteger(event.streamVersion) || event.streamVersion < 1) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid stream version.");
  }

  const payload = event.payload as Record<string, unknown>;
  if (payload.documentId !== documentId || typeof payload.documentId !== "string") {
    throw new PolicyHistoryReaderError("Policy history event document identity does not match its stream.");
  }
  if (typeof payload.policyKey !== "string" || !isPolicyKey(payload.policyKey)) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid policy key.");
  }

  if (!full) {
    return { policyKey: payload.policyKey };
  }

  // Identity is decoded for every raw event. Full value/window validation is
  // only needed for the requested key, so an unrelated document cannot poison
  // this key while a malformed key can never be skipped unseen.
  if (typeof payload.status !== "string" || !["active", "inactive"].includes(payload.status)) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid status.");
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
    throw new PolicyHistoryReaderError("Policy history event has no immutable value.");
  }
  if (
    typeof payload.effectiveFrom !== "string" ||
    (payload.effectiveUntil !== null && typeof payload.effectiveUntil !== "string")
  ) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid effective window.");
  }
  const window = normalizePolicyEffectiveWindow(payload.effectiveFrom, payload.effectiveUntil);
  const recordedAt = normalizeTimestamp(event.recordedAt, "recordedAt");
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    policyKey: payload.policyKey,
    documentId,
    streamVersion: event.streamVersion,
    globalPosition: parsePosition(event.globalPosition, "event global position"),
    recordedAt,
    status: payload.status as PolicyDocumentStatus,
    value: payload.value as JsonValue,
    effectiveFrom: normalizeTimestamp(window.effectiveFrom, "effectiveFrom"),
    effectiveUntil: window.effectiveUntil === null ? null : normalizeTimestamp(window.effectiveUntil, "effectiveUntil"),
  };
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PolicyHistoryReaderError(`Policy history ${label} must be an ISO timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new PolicyHistoryReaderError(`Policy history ${label} must be an ISO timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

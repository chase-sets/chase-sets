import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  compareGlobalPosition,
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  parseGlobalPosition,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { readGapSafeEventStoreHead, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { isPolicyKey } from "./define-policy";
import { normalizePolicyEffectiveWindow, type PolicyDocumentStatus } from "./domain";
import { policyDocumentIdFromStreamId, POLICY_DOCUMENT_STREAM_PREFIX } from "./policy-document-stream";

const POLICY_EVENT_TYPES = ["platform-policy.document.created", "platform-policy.document.revised"] as const;

/** Raised when a policy history request, source page or event is malformed. */
export class PolicyHistoryReaderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PolicyHistoryReaderError";
  }
}

/** A canonicalized immutable source event in a policy key's history. */
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

/** A JSON-serializable cursor that resumes a policy key's history after the last raw event read. */
export type PolicyHistoryContinuation = Readonly<{
  policyKey: string;
  /**
   * A fixed inclusive global-position prefix, not a time or projection watermark;
   * a later append needs a new `start`.
   */
  horizon: GlobalPosition;
  afterGlobalPosition: GlobalPosition;
}>;

/** The fixed horizon and first continuation for reading one policy key's history. */
export type PolicyHistoryStart = Readonly<{
  policyKey: string;
  /**
   * A fixed inclusive global-position prefix, not a time or projection watermark;
   * a later append needs a new `start`.
   */
  horizon: GlobalPosition;
  continuation: PolicyHistoryContinuation;
}>;

/** One bounded raw event page's records for the requested policy key. */
export type PolicyHistoryPage = Readonly<{
  records: readonly PolicyHistoryRecord[];
  /**
   * A fixed inclusive global-position prefix, not a time or projection watermark;
   * a later append needs a new `start`.
   */
  horizon: GlobalPosition;
  continuation: PolicyHistoryContinuation;
  /** True only when the raw source is exhausted through the horizon; zero target records is not completion. */
  complete: boolean;
}>;

/**
 * Reads bounded raw event pages through a fixed global-position horizon.
 * A malformed identity on any key's event fails every key's page; other keys'
 * record fields are not validated.
 */
export type PolicyHistoryReader = Readonly<{
  start: (policyKey: string) => Promise<PolicyHistoryStart>;
  readPage: (continuation: PolicyHistoryContinuation) => Promise<PolicyHistoryPage>;
}>;

/** The event store and Postgres pool a policy history reader reads from. */
export type PolicyHistoryReaderDeps = Readonly<{
  eventStore: EventStore;
  /**
   * `start` reads its horizon from `DEFAULT_EVENTS_TABLE` (`event_store_events`)
   * even when the event store uses another table.
   */
  pool: PgTransactionalPool;
}>;

/** Creates a policy history reader over the given event store and pool. */
export function createPolicyHistoryReader(deps: PolicyHistoryReaderDeps): PolicyHistoryReader {
  return {
    start: async (policyKey) => {
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
      const afterGlobalPosition = parsePosition(input.afterGlobalPosition, "continuation");
      if (compareGlobalPosition(afterGlobalPosition, horizon) > 0) {
        throw new PolicyHistoryReaderError("Policy history continuation is outside its fixed horizon.");
      }

      const rawEvents = await deps.eventStore.readAll({
        afterGlobalPosition,
        atOrBeforeGlobalPosition: horizon,
        eventTypes: POLICY_EVENT_TYPES,
        streamPrefixes: [POLICY_DOCUMENT_STREAM_PREFIX],
        limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
      });

      let lastRawPosition = afterGlobalPosition;
      const records: PolicyHistoryRecord[] = [];
      for (const event of rawEvents) {
        const position = parsePosition(event.globalPosition, "event global position");
        if (compareGlobalPosition(position, lastRawPosition) <= 0 || compareGlobalPosition(position, horizon) > 0) {
          throw new PolicyHistoryReaderError("Policy history source returned a non-advancing or out-of-horizon page.");
        }
        lastRawPosition = position;
        const identity = decodePolicyHistoryIdentity(event);
        if (identity.policyKey === policyKey) {
          records.push(decodePolicyHistoryRecord(event, identity));
        }
      }

      const continuation = { policyKey, horizon, afterGlobalPosition: lastRawPosition };
      return {
        records,
        horizon,
        continuation,
        complete: rawEvents.length < EVENT_STORE_READ_PAGE_SIZE_MAX,
      };
    },
  };
}

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

type PolicyHistoryEventIdentity = Readonly<{
  eventType: PolicyHistoryRecord["eventType"];
  documentId: string;
  policyKey: string;
  payload: Readonly<Record<string, unknown>>;
}>;

// Identity is decoded for every raw event. Full value/window validation is
// only needed for the requested key, so an unrelated document cannot poison
// this key while a malformed key can never be skipped unseen.
function decodePolicyHistoryIdentity(event: StoredEvent): PolicyHistoryEventIdentity {
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

  const payload: unknown = event.payload;
  if (!isPayloadObject(payload)) {
    throw new PolicyHistoryReaderError("Policy history event payload must be an object.");
  }
  if (payload.documentId !== documentId || typeof payload.documentId !== "string") {
    throw new PolicyHistoryReaderError("Policy history event document identity does not match its stream.");
  }
  if (typeof payload.policyKey !== "string" || !isPolicyKey(payload.policyKey)) {
    throw new PolicyHistoryReaderError("Policy history event has an invalid policy key.");
  }
  return { eventType: event.eventType, documentId, policyKey: payload.policyKey, payload };
}

function isPayloadObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePolicyHistoryRecord(event: StoredEvent, identity: PolicyHistoryEventIdentity): PolicyHistoryRecord {
  const { eventType, documentId, policyKey, payload } = identity;
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
    eventType,
    policyKey,
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

import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  SUPPORT_EVIDENCE_ABANDONMENT_MS,
  SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS,
  hasUnsettledAttachmentPut,
  replayAttachmentOperation,
  type AttachmentOperationEvent,
  type AttachmentOperationState,
} from "../domain/attachment-operation";

/** The Support evidence cleanup locator finds candidates; it never authorizes a claim. */
const LOCATOR_PROJECTION = "support-evidence-cleanup-locator-projection";

export type SupportEvidenceCleanupLocatorState =
  | "open"
  | "retained-unsettled"
  | "cleanup-pending"
  | "reference-held"
  | "deleted-unreferenced"
  | "unstaged"
  | "invalid-history";
const streamPattern = /^support\.attachment-operation-(sup_[A-Za-z0-9_-]{1,100})-(sao_[0-9A-HJKMNP-TV-Z]{26})$/;
const operationCodec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
const later = (a: number, b: number) => new Date(Math.max(a, b)).toISOString();

export function lastPutAdmittedAt(history: readonly StoredEvent[]): string | null {
  return (
    history.filter((event) => event.eventType === "support.attachment-operation.put-admitted").at(-1)?.recordedAt ??
    null
  );
}

export function deriveSupportEvidenceCleanupLocator(history: readonly StoredEvent[]): Readonly<{
  state: SupportEvidenceCleanupLocatorState;
  eligibleAt: string | null;
}> {
  let state: AttachmentOperationState;
  try {
    state = replayAttachmentOperation(history.map(operationCodec.decode));
  } catch {
    return { state: "invalid-history", eligibleAt: null };
  }
  const lastPut = lastPutAdmittedAt(history);
  const putEligible = lastPut ? Date.parse(lastPut) + SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS : 0;
  const lastActivity = Date.parse(history.at(-1)!.recordedAt);
  if (state.status === "reference-claimed" || state.status === "referenced")
    return { state: "reference-held", eligibleAt: null };
  if (state.status === "deleted-unreferenced") return { state: "deleted-unreferenced", eligibleAt: null };
  if (!state.manifest) return { state: "unstaged", eligibleAt: null };
  if (hasUnsettledAttachmentPut(state)) return { state: "retained-unsettled", eligibleAt: null };
  if (state.status === "cleanup-required" || state.status === "cleanup-claimed")
    return { state: "cleanup-pending", eligibleAt: later(putEligible, Date.parse(history[0]!.recordedAt)) };
  return { state: "open", eligibleAt: later(putEligible, lastActivity + SUPPORT_EVIDENCE_ABANDONMENT_MS) };
}

export function buildSupportEvidenceCleanupLocatorHandlers(
  db: PgQueryable,
  eventStore: EventStore,
): ProjectorHandlerMap {
  const project: ProjectorHandlerMap[string] = async (event) => {
    const match = streamPattern.exec(event.streamId);
    if (!match) return;
    // Derive from the complete operation stream so replay, rebuild and out-of-order delivery converge.
    const history = await readCompleteStream(eventStore, { streamId: event.streamId });
    if (!history.length) return;
    const locator = deriveSupportEvidenceCleanupLocator(history);
    await db.query(
      `INSERT INTO support_evidence_cleanup_locators
         (operation_stream_id, support_request_id, operation_id, state, stream_version, last_activity_at, eligible_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (operation_stream_id) DO UPDATE SET
         state = EXCLUDED.state,
         stream_version = EXCLUDED.stream_version,
         last_activity_at = EXCLUDED.last_activity_at,
         eligible_at = EXCLUDED.eligible_at
       WHERE support_evidence_cleanup_locators.stream_version <= EXCLUDED.stream_version`,
      [
        event.streamId,
        match[1],
        match[2],
        locator.state,
        history.at(-1)!.streamVersion,
        history.at(-1)!.recordedAt,
        locator.eligibleAt,
      ],
    );
  };
  return Object.fromEntries(
    [
      "staged",
      "put-admitted",
      "put-settled",
      "stored",
      "cleanup-required",
      "reference-claimed",
      "reference-claim-released",
      "referenced",
      "cleanup-claimed",
      "deleted-unreferenced",
      "cleanup-failed",
    ].map((type) => [`support.attachment-operation.${type}`, project]),
  );
}

export const supportEvidenceCleanupLocatorProjection = {
  projectionName: LOCATOR_PROJECTION,
  streamPrefixes: ["support.attachment-operation-"],
} as const;

export async function listSupportEvidenceCleanupCandidates(
  db: PgQueryable,
  input: Readonly<{ now: Date; limit: number }>,
): Promise<readonly Readonly<{ streamId: string; supportRequestId: string; operationId: string }>[]> {
  const result = await db.query<{ operation_stream_id: string; support_request_id: string; operation_id: string }>(
    `SELECT operation_stream_id, support_request_id, operation_id
       FROM support_evidence_cleanup_locators
      WHERE state IN ('open', 'cleanup-pending') AND eligible_at <= $1
      ORDER BY eligible_at, operation_stream_id
      LIMIT $2`,
    [input.now.toISOString(), input.limit],
  );
  return result.rows.map((row) => ({
    streamId: row.operation_stream_id,
    supportRequestId: row.support_request_id,
    operationId: row.operation_id,
  }));
}

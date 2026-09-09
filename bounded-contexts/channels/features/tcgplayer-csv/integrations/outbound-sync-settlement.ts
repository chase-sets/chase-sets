import type {
  BoundClaimedReservationRun,
  ClaimedOperationOutcome,
  ClaimedReservationRunSettlementPort,
} from "../../outbound-sync/domain/contracts";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { deriveClaimedOperationOutcomes } from "../domain/lifecycle";
import { channelSyncRunEventCodec } from "../domain/codec";
import type { ChannelSyncRun, ChannelSyncRunTransitionedEvent } from "../domain/contracts";
import { projectChannelSyncRunTransitioned } from "../read-model/projection";
import { readChannelSyncRunByReservation } from "../read-model/queries";

export function createTcgplayerClaimedReservationRunSettlementPort(
  eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction">,
): ClaimedReservationRunSettlementPort {
  return {
    lockBoundRun: async (transaction, input) => {
      const runProjection: PgQueryable = transaction;
      const run = await readChannelSyncRunByReservation(runProjection, input.reservationId, true);
      if (!run) return null;
      if (input.runId !== undefined && run.runId !== input.runId) return null;
      if (input.expectedRunRevision !== undefined && run.revision !== input.expectedRunRevision) return null;
      return toBoundRun(run);
    },
    settleBoundRun: async (transaction, input) => {
      const runProjection: PgQueryable = transaction;
      const run = await readChannelSyncRunByReservation(runProjection, input.reservationId, true);
      if (
        !run ||
        run.runId !== input.runId ||
        run.revision !== input.expectedRunRevision ||
        run.state !== input.fromState
      ) {
        throw new Error("Channel Sync Run settlement fence is stale.");
      }
      const settledRun: ChannelSyncRun = {
        ...run,
        state: input.toState,
        verificationSnapshotId: input.verificationSnapshotId ?? run.verificationSnapshotId,
        verificationSnapshotGeneration: input.verificationSnapshotGeneration ?? run.verificationSnapshotGeneration,
        uploadAttemptedAt: input.uploadAttemptedAt ?? run.uploadAttemptedAt,
        uploadFileName: input.uploadFileName ?? run.uploadFileName,
        importSummary: input.importSummary ?? run.importSummary,
      };
      if (!sameOutcomes(deriveClaimedOperationOutcomes(settledRun), input.outcomes)) {
        throw new Error("Channel Sync Run settlement outcomes do not match its immutable member partition.");
      }
      const event: ChannelSyncRunTransitionedEvent = {
        type: "channels.tcgplayer-sync-run.transitioned",
        data: {
          runId: input.runId,
          reservationId: input.reservationId,
          expectedRevision: input.expectedRunRevision,
          fromState: input.fromState,
          toState: input.toState,
          verificationSnapshotId: input.verificationSnapshotId,
          verificationSnapshotGeneration: input.verificationSnapshotGeneration,
          uploadAttemptedAt: input.uploadAttemptedAt,
          uploadFileName: input.uploadFileName,
          importSummary: input.importSummary,
        },
      };
      const stored = await eventStore.appendToStreamInTransaction(transaction, {
        streamId: `channels.tcgplayer-sync-run-${input.runId}`,
        expectedVersion: input.expectedRunRevision + 1,
        wakeSourceContextName: "channels",
        context: input.context ?? (await readRunOriginContext(transaction, input.runId)),
        events: [channelSyncRunEventCodec.encode(event)],
      });
      const receipt = stored[0];
      if (!receipt || stored.length !== 1) throw new Error("Channel Sync Run settlement append returned no receipt.");
      await projectChannelSyncRunTransitioned(transaction, event.data, receipt.streamVersion, receipt.recordedAt);
    },
  };
}

function toBoundRun(run: ChannelSyncRun): BoundClaimedReservationRun {
  return {
    runId: run.runId,
    revision: run.revision,
    reservationId: run.reservationId,
    state: terminalOrCurrent(run.state),
    submitMayHaveOccurred: run.state === "awaiting-verification",
    uploadAttemptedAt: run.uploadAttemptedAt,
    claimant: run.claimant,
    outcomes: deriveClaimedOperationOutcomesForSettlement(run),
  };
}

function sameOutcomes(
  expected: readonly ClaimedOperationOutcome[],
  actual: readonly ClaimedOperationOutcome[],
): boolean {
  if (expected.length !== actual.length) return false;
  const actualByOperation = new Map(actual.map((outcome) => [outcome.operationId, outcome]));
  return (
    actualByOperation.size === actual.length &&
    expected.every((outcome) => {
      const actualOutcome = actualByOperation.get(outcome.operationId);
      return actualOutcome !== undefined && canonicalJson(outcome) === canonicalJson(actualOutcome);
    })
  );
}

async function readRunOriginContext(db: PgQueryable, runId: string): Promise<EventStoreContext> {
  const result = await db.query<{
    tenant_id: string;
    performed_by_user_id: string;
    for_account_id: string;
    trace_id: string | null;
    span_id: string | null;
    parent_span_id: string | null;
    trace_state: string | null;
  }>(
    `SELECT event.tenant_id,event.performed_by_user_id,event.for_account_id,
            event.trace_id,event.span_id,event.parent_span_id,event.trace_state
     FROM channel_sync_run_rows AS member
     JOIN channel_outbound_operations AS operation ON operation.operation_id=member.operation_id
     JOIN event_store_events AS event ON event.event_id=operation.source_event_id
     WHERE member.run_id=$1
     ORDER BY member.ordinal
     LIMIT 1`,
    [runId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Channel Sync Run origin context is unavailable.");
  const trace =
    row.trace_id || row.span_id || row.parent_span_id || row.trace_state
      ? {
          ...(row.trace_id ? { traceId: row.trace_id } : {}),
          ...(row.span_id ? { spanId: row.span_id } : {}),
          ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
          ...(row.trace_state ? { traceState: row.trace_state } : {}),
        }
      : undefined;
  return {
    tenantId: row.tenant_id,
    audit: { performedByUserId: row.performed_by_user_id, forAccountId: row.for_account_id },
    ...(trace ? { trace } : {}),
  } as EventStoreContext;
}

function deriveClaimedOperationOutcomesForSettlement(run: ChannelSyncRun) {
  if (run.state === "composed" || run.state === "claimed") {
    return deriveClaimedOperationOutcomes({ ...run, state: "abandoned" });
  }
  if (run.state === "awaiting-verification") {
    return deriveClaimedOperationOutcomes({ ...run, state: "application-unknown" });
  }
  return deriveClaimedOperationOutcomes(run);
}

function terminalOrCurrent(state: ChannelSyncRun["state"]): BoundClaimedReservationRun["state"] {
  if (state === "composed" || state === "claimed" || state === "awaiting-verification") return state;
  return "terminal";
}

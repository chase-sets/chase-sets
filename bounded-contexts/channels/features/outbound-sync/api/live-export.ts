import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelProviderIdentity, ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import { decodeConnectorPolicy, type ConnectorPolicy } from "../../connector-feed/domain/policy";
import { assertAdditionalOutboundHold, resolveConnectionExecutionAdmission } from "../domain/admission";
import {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedLiveExportOperation,
  type LiveExportOperationRecord,
  type OutboundConnection,
  type OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import {
  liveExportBounds,
  liveExportFitsLease,
  liveExportHeaderSha256,
  liveExportOperationKind,
  assertLiveExportOutcomeBody,
  type ClaimedLiveExportOutcome,
  type LiveExportPayload,
} from "../domain/live-export-codec";
import { assertLiveExportPayload, deriveLiveExportId, deriveLiveExportOperationId } from "./live-export-payload";
import { advanceScheduledBoundary, orderPullScheduleDue, type OrderPullScanCursor } from "./order-pull";
import { payloadDigest } from "./payload-digest";

type ScheduleRow = Readonly<{
  generation: string | number;
  next_due_at: Date | string;
  last_scheduled_at: Date | string;
  revision: string | number;
}>;
type OperationRow = Readonly<{
  operation_id: string;
  connection_id: string;
  operation_kind: string;
  export_id: string;
  schedule_generation: string | number;
  payload: unknown;
  payload_digest: string;
  status: LiveExportOperationRecord["status"];
  revision: string | number;
  attempt_id: string | null;
  claim_generation: string | number;
  claimant_kind: "connector" | null;
  claim_owner_id: string | null;
  reservation_id: string | null;
  claimed_until: Date | string | null;
  outcome: unknown;
  enqueued_at: Date | string;
}>;
const columns = `operation_id, connection_id, operation_kind, export_id, schedule_generation, payload,
  payload_digest, status, revision, attempt_id, claim_generation, claimant_kind, claim_owner_id,
  reservation_id, claimed_until, outcome, enqueued_at`;
const dueConnectionsPerTick = 100;

export async function scheduleDueLiveExports(
  dependencies: OutboundSyncRuntimeDependencies,
  input: Readonly<{ registry: ChannelProviderRegistry }>,
  now: () => string,
  scan: OrderPullScanCursor,
): Promise<number> {
  if (!dependencies.liveExport) return 0;
  let policy: ConnectorPolicy;
  try {
    policy = decodeConnectorPolicy(await dependencies.liveExport.resolveConnectorPolicy());
  } catch {
    throw new OutboundSyncError(
      "live-export-schedule-unavailable",
      "The connector transport policy could not be resolved.",
    );
  }
  if (!liveExportFitsLease(liveExportBounds.budgetMs, policy.leaseMs)) return 0;
  const intervalMs = policy.liveExportIntervalSeconds * 1000;
  const at = now();
  const from = scan.current();
  const candidates = await dependencies.db.query<{ connection_id: string }>(
    `SELECT connection.connection_id FROM channel_connections AS connection
     JOIN channel_connector_pairings AS pairing ON pairing.connection_id = connection.connection_id AND pairing.state = 'paired'
     LEFT JOIN channel_live_export_schedules AS schedule ON schedule.connection_id = connection.connection_id
     WHERE connection.status = 'active' AND connection.provider_key = 'tcgplayer'
       AND ($3::text IS NULL OR connection.connection_id > $3)
       AND (schedule.connection_id IS NULL OR (schedule.next_due_at <= $1 AND schedule.last_scheduled_at <= $2))
       AND NOT EXISTS (SELECT 1 FROM channel_live_export_operations AS live
         WHERE live.connection_id = connection.connection_id AND live.status IN ('pending', 'in-flight'))
     ORDER BY connection.connection_id LIMIT $4`,
    [at, new Date(Date.parse(at) - intervalMs).toISOString(), from.after, dueConnectionsPerTick],
  );
  let scheduled = 0;
  let examined: string | null = null;
  let completed = false;
  try {
    for (const candidate of candidates.rows) {
      examined = candidate.connection_id;
      if (
        await withPgTransaction(dependencies.db, (db) =>
          scheduleConnection(dependencies, db, {
            connectionId: candidate.connection_id,
            registry: input.registry,
            policy,
            at: now(),
          }),
        )
      )
        scheduled++;
    }
    completed = true;
  } finally {
    scan.advance(from, completed && candidates.rows.length < dueConnectionsPerTick ? null : examined);
  }
  return scheduled;
}

async function scheduleConnection(
  dependencies: OutboundSyncRuntimeDependencies,
  db: PgQueryable,
  input: Readonly<{ connectionId: string; registry: ChannelProviderRegistry; policy: ConnectorPolicy; at: string }>,
): Promise<boolean> {
  const connections = await db.query<{
    connection_id: string;
    provider_key: string;
    environment: OutboundConnection["environment"];
    status: OutboundConnection["status"];
  }>(
    `SELECT connection_id, provider_key, environment, status FROM channel_connections WHERE connection_id = $1 FOR SHARE`,
    [input.connectionId],
  );
  const row = connections.rows[0];
  if (!row || row.status !== "active" || row.provider_key !== "tcgplayer") return false;
  const connection = {
    connectionId: row.connection_id,
    providerKey: row.provider_key,
    environment: row.environment,
    status: row.status,
  };
  const paired = await db.query(
    `SELECT pairing_id FROM channel_connector_pairings
    WHERE connection_id = $1 AND state = 'paired' FOR SHARE`,
    [input.connectionId],
  );
  if (paired.rows.length !== 1) return false;
  const admission = resolveConnectionExecutionAdmission(input.registry, connection);
  if (admission.kind !== "claimed") return false;
  const hold = await dependencies.readAdditionalOutboundHold({
    connectionId: input.connectionId,
    providerIdentity: admission.providerIdentity,
  });
  assertAdditionalOutboundHold(hold);
  if (hold.held) return false;
  const schedules = await db.query<ScheduleRow>(
    `SELECT generation, next_due_at, last_scheduled_at, revision
    FROM channel_live_export_schedules WHERE connection_id = $1 FOR UPDATE`,
    [input.connectionId],
  );
  const current = schedules.rows[0];
  const intervalMs = input.policy.liveExportIntervalSeconds * 1000;
  if (
    current &&
    !orderPullScheduleDue(
      { nextDueAt: timestamp(current.next_due_at)!, lastScheduledAt: timestamp(current.last_scheduled_at)! },
      input.at,
      intervalMs,
    )
  )
    return false;
  const live = await db.query(
    `SELECT operation_id FROM channel_live_export_operations
    WHERE connection_id = $1 AND status IN ('pending', 'in-flight') FOR UPDATE`,
    [input.connectionId],
  );
  if (live.rows.length) return false;
  const generation = current ? Number(current.generation) + 1 : 1;
  if (!Number.isSafeInteger(generation)) throw new OutboundSyncError("stale-fence");
  const boundary = current
    ? advanceScheduledBoundary(timestamp(current.last_scheduled_at)!, input.at, intervalMs)
    : input.at;
  const nextDueAt = new Date(Date.parse(boundary) + intervalMs).toISOString();
  const advanced = current
    ? await db.query(
        `UPDATE channel_live_export_schedules
        SET generation = $2, next_due_at = $3, last_scheduled_at = $4, revision = revision + 1, updated_at = $5
        WHERE connection_id = $1 AND revision = $6 AND generation = $7 RETURNING connection_id`,
        [input.connectionId, generation, nextDueAt, boundary, input.at, current.revision, current.generation],
      )
    : await db.query(
        `INSERT INTO channel_live_export_schedules
        (connection_id, generation, next_due_at, last_scheduled_at, revision, updated_at)
        VALUES ($1, $2, $3, $4, 1, $5) ON CONFLICT (connection_id) DO NOTHING RETURNING connection_id`,
        [input.connectionId, generation, nextDueAt, boundary, input.at],
      );
  if (advanced.rows.length !== 1) {
    if (current) throw new OutboundSyncError("stale-fence");
    return false;
  }
  const payload: LiveExportPayload = {
    kind: "live-export",
    version: 1,
    connectionId: input.connectionId,
    exportId: deriveLiveExportId(input.connectionId, generation),
    scheduleGeneration: generation,
    parserProfile: { id: "tcgplayer-live-export/v1", headerSha256: liveExportHeaderSha256 },
    limits: { maxBytes: input.policy.maxIngestBytes, maxRecords: input.policy.maxIngestRecords },
    bounds: liveExportBounds,
  };
  assertLiveExportPayload(payload, input.policy.leaseMs);
  await db.query(
    `INSERT INTO channel_live_export_operations
    (operation_id, connection_id, operation_kind, export_id, schedule_generation, payload, payload_digest, status, revision, enqueued_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', 1, $8)`,
    [
      deriveLiveExportOperationId(input.connectionId, generation),
      input.connectionId,
      liveExportOperationKind,
      payload.exportId,
      generation,
      JSON.stringify(payload),
      payloadDigest(payload),
      input.at,
    ],
  );
  return true;
}

export async function reserveLiveExport(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    providerIdentity: ChannelProviderIdentity;
    claimant: ClaimedOperationClaimant;
    reservationId: string;
    reservedAt: string;
    leaseExpiresAt: string;
    attemptId: string;
  }>,
): Promise<ClaimedLiveExportOperation | null> {
  if (input.claimant.claimantKind !== "connector" || input.providerIdentity.providerKey !== "tcgplayer") return null;
  const pending = await db.query<OperationRow>(
    `SELECT ${columns} FROM channel_live_export_operations
    WHERE connection_id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
    [input.connectionId],
  );
  if (!pending.rows[0]) return null;
  const member = mapRow(pending.rows[0]);
  if (
    !liveExportFitsLease(
      member.payload.bounds.budgetMs,
      Date.parse(input.leaseExpiresAt) - Date.parse(input.reservedAt),
    )
  )
    return null;
  const claimed = await db.query<OperationRow>(
    `UPDATE channel_live_export_operations
    SET status = 'in-flight', revision = revision + 1, attempt_id = $2, claim_generation = claim_generation + 1,
        claimant_kind = 'connector', claim_owner_id = $3, reservation_id = $4, claimed_until = $5,
        attempt_count = attempt_count + 1, first_claimed_at = COALESCE(first_claimed_at, $6)
    WHERE operation_id = $1 AND status = 'pending' AND revision = $7 AND claim_generation = $8 RETURNING ${columns}`,
    [
      member.operationId,
      input.attemptId,
      input.claimant.claimantId,
      input.reservationId,
      input.leaseExpiresAt,
      input.reservedAt,
      member.revision,
      member.claimGeneration,
    ],
  );
  if (!claimed.rows[0]) throw new OutboundSyncError("stale-fence");
  const result = mapRow(claimed.rows[0]);
  return {
    operationId: result.operationId,
    attemptId: result.attemptId!,
    claimGeneration: result.claimGeneration,
    connectionId: result.connectionId,
    providerIdentity: input.providerIdentity,
    subject: { kind: "connection", connectionId: result.connectionId },
    operationKind: liveExportOperationKind,
    exportId: result.exportId,
    scheduleGeneration: result.scheduleGeneration,
    payload: result.payload,
    payloadDigest: result.payloadDigest,
    enqueuedAt: result.enqueuedAt,
  };
}

export async function lockReservedLiveExports(
  db: PgQueryable,
  reservationId: string,
): Promise<readonly LiveExportOperationRecord[]> {
  const result = await db.query<OperationRow>(
    `SELECT ${columns} FROM channel_live_export_operations
    WHERE reservation_id = $1 AND status = 'in-flight' ORDER BY operation_id FOR UPDATE`,
    [reservationId],
  );
  return result.rows.map(mapRow);
}

export function assertLiveExportReportFence(
  member: LiveExportOperationRecord,
  report: ClaimedLiveExportOutcome,
  claimant: ClaimedOperationClaimant,
): void {
  if (
    member.claimantKind !== claimant.claimantKind ||
    member.claimOwnerId !== claimant.claimantId ||
    member.attemptId !== report.attemptId ||
    member.claimGeneration !== report.claimGeneration ||
    member.exportId !== report.exportId ||
    member.payloadDigest !== report.payloadDigest ||
    (report.outcome.kind === "live-export-complete" && report.outcome.parsedRowCount > member.payload.limits.maxRecords)
  )
    throw new OutboundSyncError("reservation-membership-mismatch");
}

/** Every reported export outcome is terminal, including proven abandonment. */
export async function settleLiveExportMember(
  db: PgQueryable,
  member: LiveExportOperationRecord,
  report: ClaimedLiveExportOutcome,
  at: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE channel_live_export_operations
    SET status = $6, revision = revision + 1, outcome = $7::jsonb, terminal_at = $8, claimed_until = NULL
    WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2 AND attempt_id = $3
      AND claim_generation = $4 AND reservation_id = $5`,
    [
      member.operationId,
      member.revision,
      member.attemptId,
      member.claimGeneration,
      member.reservationId,
      report.outcome.kind === "live-export-complete" ? "succeeded" : "failed",
      JSON.stringify(report.outcome),
      at,
    ],
  );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
}

/** Only an unreported expired attempt returns to pending, with unchanged payload and export identity. */
export async function recoverExpiredLiveExports(db: PgQueryable, at: string): Promise<number> {
  const result = await db.query(
    `UPDATE channel_live_export_operations AS operation
    SET status = 'pending', revision = operation.revision + 1, attempt_id = NULL, claimant_kind = NULL,
        claim_owner_id = NULL, reservation_id = NULL, claimed_until = NULL
    FROM (SELECT operation_id, revision, claim_generation FROM channel_live_export_operations
      WHERE status = 'in-flight' AND claimed_until <= $1 ORDER BY claimed_until, operation_id
      LIMIT 100 FOR UPDATE SKIP LOCKED) AS expired
    WHERE operation.operation_id = expired.operation_id AND operation.status = 'in-flight'
      AND operation.revision = expired.revision AND operation.claim_generation = expired.claim_generation`,
    [at],
  );
  return Number(result.rowCount ?? 0);
}

function mapRow(row: OperationRow): LiveExportOperationRecord {
  assertLiveExportPayload(row.payload);
  const outcome = row.outcome;
  if (outcome !== null) assertLiveExportOutcomeBody(outcome);
  if (
    row.operation_kind !== liveExportOperationKind ||
    row.payload.connectionId !== row.connection_id ||
    row.payload.exportId !== row.export_id ||
    row.payload.scheduleGeneration !== Number(row.schedule_generation) ||
    row.operation_id !== deriveLiveExportOperationId(row.connection_id, Number(row.schedule_generation)) ||
    payloadDigest(row.payload) !== row.payload_digest
  )
    throw new OutboundSyncError("stale-fence", "Stored live-export identity does not match its payload.");
  return {
    operationId: row.operation_id,
    connectionId: row.connection_id,
    exportId: row.export_id,
    scheduleGeneration: Number(row.schedule_generation),
    payload: row.payload,
    payloadDigest: row.payload_digest,
    status: row.status,
    revision: Number(row.revision),
    attemptId: row.attempt_id,
    claimGeneration: Number(row.claim_generation),
    claimantKind: row.claimant_kind,
    claimOwnerId: row.claim_owner_id,
    reservationId: row.reservation_id,
    claimedUntil: timestamp(row.claimed_until),
    outcome,
    enqueuedAt: timestamp(row.enqueued_at)!,
  };
}
function timestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

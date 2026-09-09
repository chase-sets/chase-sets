import { createHash, randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { resolveConnectionExecutionAdmission } from "../domain/admission";
import {
  OutboundSyncError,
  type ClaimedOperationReservation,
  type EnqueueOutboundOperation,
  type OutboundConnection,
  type OutboundOperationLane,
  type OutboundOperationRecord,
  type OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import { assertEnqueueOutboundOperation, assertOutboundClaimLeaseMs, payloadDigest } from "../domain/validation";

type OperationRow = Readonly<{
  operation_id: string;
  connection_id: string;
  channel_listing_id: string;
  listing_id: string;
  operation_kind: "publish" | "update" | "delist";
  listing_revision: string | number;
  source_desired_state_sequence: string | number;
  payload: unknown;
  payload_digest: string;
  status: "pending" | "in-flight" | "succeeded" | "failed";
  revision: string | number;
  attempt_id: string | null;
  claim_generation: string | number;
  claimant_kind: "inline" | "connector" | "manual" | null;
  claim_owner_id: string | null;
  reservation_id: string | null;
  claimed_until: Date | string | null;
  attempt_count: number | string;
  next_attempt_at: Date | string;
  last_rejection_code: string | null;
  terminal_reason: string | null;
  link_write_state: "pending" | "applied" | "link-write-refused";
  source_event_id: string;
  source_stream_id: string;
  source_stream_version: string | number;
  source_global_position: string | number | bigint;
  source_desired_state_hash: string;
  source_occurred_at: Date | string;
  enqueued_at: Date | string;
  first_claimed_at: Date | string | null;
  terminal_at: Date | string | null;
}>;

type ConnectionRow = Readonly<{
  connection_id: string;
  provider_key: string;
  environment: "sandbox" | "production";
  status: "pending-setup" | "active" | "paused" | "disconnected";
}>;

type LaneRow = Readonly<{
  connection_id: string;
  channel_listing_id: string;
  generation: string | number;
  blocked_operation_id: string | null;
  blocked_reason: string | null;
  blocked_at: Date | string | null;
  cleared_at: Date | string | null;
  revision: string | number;
}>;

const operationColumns = `operation_id, connection_id, channel_listing_id, listing_id, operation_kind,
  listing_revision, source_desired_state_sequence, payload, payload_digest, status, revision,
  attempt_id, claim_generation, claimant_kind, claim_owner_id, reservation_id, claimed_until,
  attempt_count, next_attempt_at, last_rejection_code, terminal_reason, link_write_state,
  source_event_id, source_stream_id, source_stream_version, source_global_position,
  source_desired_state_hash, source_occurred_at, enqueued_at, first_claimed_at, terminal_at`;

export function createOutboundOperationStore(
  dependencies: OutboundSyncRuntimeDependencies,
  options: Readonly<{ assertDelistDirective: (value: unknown) => void }>,
) {
  const now = () => (dependencies.clock?.now() ?? new Date()).toISOString();

  return {
    enqueueDesiredState: async (input: EnqueueOutboundOperation): Promise<OutboundOperationRecord | null> => {
      assertEnqueueOutboundOperation(input, options.assertDelistDirective);
      const digest = payloadDigest(input.payload);
      const operationId = deriveOperationId(input);
      return withPgTransaction(dependencies.db, async (db) => {
        await db.query(
          `INSERT INTO channel_outbound_lanes (connection_id, channel_listing_id)
           VALUES ($1, $2)
           ON CONFLICT (connection_id, channel_listing_id) DO NOTHING`,
          [input.connectionId, input.channelListingId],
        );
        await db.query(
          `SELECT revision FROM channel_outbound_lanes
           WHERE connection_id = $1 AND channel_listing_id = $2
           FOR UPDATE`,
          [input.connectionId, input.channelListingId],
        );
        const current = await db.query<
          Pick<OperationRow, "operation_id" | "status" | "revision" | "source_desired_state_sequence">
        >(
          `SELECT operation_id, status, revision, source_desired_state_sequence
           FROM channel_outbound_operations
           WHERE connection_id = $1 AND channel_listing_id = $2
           ORDER BY source_desired_state_sequence DESC
           FOR UPDATE`,
          [input.connectionId, input.channelListingId],
        );
        if (current.rows.some((row) => Number(row.source_desired_state_sequence) >= input.desiredStateSequence))
          return null;
        const pending = current.rows.find((row) => row.status === "pending");
        const enqueuedAt = now();
        const values = operationValues(operationId, input, digest, enqueuedAt);
        const result = pending
          ? await db.query<OperationRow>(
              `UPDATE channel_outbound_operations
               SET operation_id = $1, listing_id = $2, operation_kind = $3, listing_revision = $4,
                   source_desired_state_sequence = $5, payload = $6::jsonb, payload_digest = $7,
                   revision = revision + 1, attempt_id = NULL, claimant_kind = NULL,
                   claim_owner_id = NULL, reservation_id = NULL, claimed_until = NULL,
                   next_attempt_at = $8, last_rejection_code = NULL, terminal_reason = NULL,
                   link_write_state = 'pending', source_event_id = $9, source_stream_id = $10,
                   source_stream_version = $11, source_global_position = $12,
                   source_desired_state_hash = $13, source_occurred_at = $14, enqueued_at = $8,
                   first_claimed_at = NULL, terminal_at = NULL, attempt_count = 0
               WHERE operation_id = $15 AND status = 'pending' AND revision = $16
               RETURNING ${operationColumns}`,
              [
                operationId,
                input.listingId,
                input.operationKind,
                input.listingRevision,
                input.desiredStateSequence,
                JSON.stringify(input.payload),
                digest,
                enqueuedAt,
                input.envelope.sourceEventId,
                input.envelope.sourceStreamId,
                input.envelope.sourceStreamVersion,
                input.envelope.sourceGlobalPosition,
                input.desiredStateHash,
                input.envelope.sourceOccurredAt,
                pending.operation_id,
                pending.revision,
              ],
            )
          : await db.query<OperationRow>(
              `INSERT INTO channel_outbound_operations (
                 operation_id, connection_id, channel_listing_id, listing_id, operation_kind,
                 listing_revision, source_desired_state_sequence, payload, payload_digest,
                 status, revision, next_attempt_at, source_event_id, source_stream_id,
                 source_stream_version, source_global_position, source_desired_state_hash,
                 source_occurred_at, enqueued_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',1,$10,$11,$12,$13,$14,$15,$16,$10)
               RETURNING ${operationColumns}`,
              values,
            );
        const row = result.rows[0];
        if (!row) throw new OutboundSyncError("stale-fence");
        return mapOperation(row);
      });
    },

    reserveClaimedOutboundOperations: async (input: {
      registry: Parameters<typeof resolveConnectionExecutionAdmission>[0];
      connectionId: string;
      claimant: { claimantKind: "connector" | "manual"; claimantId: string };
      maxOperations: number;
      leaseMs: number;
    }): Promise<ClaimedOperationReservation | null> => {
      assertOutboundClaimLeaseMs(input.leaseMs);
      if (!Number.isSafeInteger(input.maxOperations) || input.maxOperations < 1 || input.maxOperations > 1_000_000) {
        throw new OutboundSyncError("invalid-input", "maxOperations must be an integer from 1 to 1000000.");
      }
      if (!input.claimant.claimantId || !["connector", "manual"].includes(input.claimant.claimantKind)) {
        throw new OutboundSyncError("invalid-input", "claimant is invalid.");
      }
      return withPgTransaction(dependencies.db, async (db) => {
        const connection = await readConnection(db, input.connectionId, true);
        if (!connection) throw new OutboundSyncError("connection-not-found");
        if (connection.status !== "active") throw new OutboundSyncError("connection-not-active");
        const admission = resolveConnectionExecutionAdmission(input.registry, connection);
        if (admission.kind !== "claimed") throw new OutboundSyncError("execution-mode-mismatch");
        const selected = await db.query<OperationRow>(
          `SELECT ${operationColumns.replaceAll(/\b([a-z][a-z0-9_]*)\b/g, "operation.$1")}
           FROM channel_outbound_operations AS operation
           JOIN channel_outbound_lanes AS lane
             ON lane.connection_id = operation.connection_id
            AND lane.channel_listing_id = operation.channel_listing_id
           WHERE operation.connection_id = $1
             AND operation.status = 'pending'
             AND operation.next_attempt_at <= $2
             AND lane.blocked_operation_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM channel_outbound_operations AS active
               WHERE active.connection_id = operation.connection_id
                 AND active.channel_listing_id = operation.channel_listing_id
                 AND active.status = 'in-flight'
             )
           ORDER BY operation.enqueued_at, operation.operation_id
           LIMIT $3
           FOR UPDATE OF operation SKIP LOCKED`,
          [input.connectionId, now(), input.maxOperations],
        );
        if (selected.rows.length === 0) return null;
        const reservationId = `cor_${randomUUID()}`;
        const reservedAt = now();
        const leaseExpiresAt = new Date(Date.parse(reservedAt) + input.leaseMs).toISOString();
        const operations = [];
        for (const selectedRow of selected.rows) {
          const attemptId = `coa_${randomUUID()}`;
          const updated = await db.query<OperationRow>(
            `UPDATE channel_outbound_operations
             SET status = 'in-flight', revision = revision + 1, attempt_id = $2,
                 claim_generation = claim_generation + 1, claimant_kind = $3,
                 claim_owner_id = $4, reservation_id = $5, claimed_until = $6,
                 attempt_count = attempt_count + 1, first_claimed_at = COALESCE(first_claimed_at, $7)
             WHERE operation_id = $1 AND status = 'pending' AND revision = $8
             RETURNING ${operationColumns}`,
            [
              selectedRow.operation_id,
              attemptId,
              input.claimant.claimantKind,
              input.claimant.claimantId,
              reservationId,
              leaseExpiresAt,
              reservedAt,
              selectedRow.revision,
            ],
          );
          const row = updated.rows[0];
          if (!row) throw new OutboundSyncError("stale-fence");
          operations.push({
            operationId: row.operation_id,
            attemptId: row.attempt_id!,
            claimGeneration: Number(row.claim_generation),
            connectionId: row.connection_id,
            providerIdentity: admission.providerIdentity,
            channelListingId: row.channel_listing_id,
            listingId: row.listing_id,
            operationKind: row.operation_kind,
            listingRevision: Number(row.listing_revision),
            desiredStateSequence: Number(row.source_desired_state_sequence),
            payload: row.payload as never,
            payloadDigest: row.payload_digest,
            sourceOccurredAt: timestamp(row.source_occurred_at)!,
            enqueuedAt: timestamp(row.enqueued_at)!,
          });
        }
        return {
          reservationId,
          connectionId: input.connectionId,
          providerIdentity: admission.providerIdentity,
          claimant: input.claimant,
          reservedAt,
          leaseExpiresAt,
          operations,
        };
      });
    },
  };
}

async function readConnection(
  db: PgQueryable,
  connectionId: string,
  lock: boolean,
): Promise<OutboundConnection | null> {
  const result = await db.query<ConnectionRow>(
    `SELECT connection_id, provider_key, environment, status
     FROM channel_connections
     WHERE connection_id = $1${lock ? " FOR SHARE" : ""}`,
    [connectionId],
  );
  const row = result.rows[0];
  return row
    ? {
        connectionId: row.connection_id,
        providerKey: row.provider_key,
        environment: row.environment,
        status: row.status,
      }
    : null;
}

function operationValues(operationId: string, input: EnqueueOutboundOperation, digest: string, enqueuedAt: string) {
  return [
    operationId,
    input.connectionId,
    input.channelListingId,
    input.listingId,
    input.operationKind,
    input.listingRevision,
    input.desiredStateSequence,
    JSON.stringify(input.payload),
    digest,
    enqueuedAt,
    input.envelope.sourceEventId,
    input.envelope.sourceStreamId,
    input.envelope.sourceStreamVersion,
    input.envelope.sourceGlobalPosition,
    input.desiredStateHash,
    input.envelope.sourceOccurredAt,
  ] as const;
}

function deriveOperationId(input: EnqueueOutboundOperation): string {
  return `cop_${createHash("sha256")
    .update(`${input.connectionId}\0${input.channelListingId}\0${input.envelope.sourceEventId}`, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

export function mapOperation(row: OperationRow): OutboundOperationRecord {
  return {
    operationId: row.operation_id,
    connectionId: row.connection_id,
    channelListingId: row.channel_listing_id,
    listingId: row.listing_id,
    operationKind: row.operation_kind,
    listingRevision: Number(row.listing_revision),
    sourceDesiredStateSequence: Number(row.source_desired_state_sequence),
    payload: row.payload as never,
    payloadDigest: row.payload_digest,
    status: row.status,
    revision: Number(row.revision),
    attemptId: row.attempt_id,
    claimGeneration: Number(row.claim_generation),
    claimantKind: row.claimant_kind,
    claimOwnerId: row.claim_owner_id,
    reservationId: row.reservation_id,
    claimedUntil: timestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: timestamp(row.next_attempt_at)!,
    lastRejectionCode: row.last_rejection_code,
    terminalReason: row.terminal_reason,
    linkWriteState: row.link_write_state,
    sourceEventId: row.source_event_id,
    sourceStreamId: row.source_stream_id,
    sourceStreamVersion: Number(row.source_stream_version),
    sourceGlobalPosition: parseGlobalPosition(String(row.source_global_position)),
    sourceDesiredStateHash: row.source_desired_state_hash,
    sourceOccurredAt: timestamp(row.source_occurred_at)!,
    enqueuedAt: timestamp(row.enqueued_at)!,
    firstClaimedAt: timestamp(row.first_claimed_at),
    terminalAt: timestamp(row.terminal_at),
  };
}

function mapLane(row: LaneRow): OutboundOperationLane {
  return {
    connectionId: row.connection_id,
    channelListingId: row.channel_listing_id,
    generation: Number(row.generation),
    blockedOperationId: row.blocked_operation_id,
    blockedReason: row.blocked_reason,
    blockedAt: timestamp(row.blocked_at),
    clearedAt: timestamp(row.cleared_at),
    revision: Number(row.revision),
  };
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value === null ? null : new Date(value).toISOString();
}

export const outboundOperationSqlColumns = operationColumns;
export const mapOutboundOperationRow = mapOperation;
export const mapOutboundLaneRow = mapLane;

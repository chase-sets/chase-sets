import { createEventStoreError } from "@chase-sets/event-core/event-store";
import {
  assertOwnerStreamReservationInput,
  OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE,
  OWNER_STREAM_MAX_PURPOSES,
  OWNER_STREAM_MAX_RESOURCES,
  type InboundEvidenceResult,
  type InvalidationIntent,
  type OwnerStreamReservation,
  type OwnerStreamReservationStore,
  type RequestTerminal,
  type RequestTerminalBinding,
  type ReserveOwnerStreamInput,
} from "@chase-sets/event-core/owner-stream-reservation";
import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "./types";

type DbReservation = Readonly<{
  reservation_id: string;
  operation_id: string;
  owner_stream_id: string;
  purpose: string;
  resource_key: string;
  consumer_store_id: string;
  request_id: string;
  seal_version: string | number;
  store_incarnation: string;
  target: unknown;
  command_fingerprint: string;
  status: "OPEN" | "RELEASED";
  release_status: "COMMITTED" | "ABORTED" | null;
}>;
type DbTerminal = Readonly<{
  consumer_store_id: string;
  request_id: string;
  status: "OPEN" | "COMMITTED" | "ABORTED";
  reservation_ids: string[];
}>;

export type PostgresOwnerStreamReservationStoreConfig = Readonly<{
  pool?: PgTransactionalPool;
  ownerPool?: PgTransactionalPool;
  consumerPool?: PgTransactionalPool;
  now?: () => IsoUtcTimestamp;
}>;

const OWNER_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('owner_stream:' || $1::text, 0))";
const TERMINAL_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('request_terminal:' || $1::text || ':' || $2::text, 0))";

export function createPostgresOwnerStreamReservationStore(
  config: PostgresOwnerStreamReservationStoreConfig,
): OwnerStreamReservationStore {
  const ownerPool = config.ownerPool ?? config.pool;
  const consumerPool = config.consumerPool ?? config.pool;
  if (!ownerPool || !consumerPool) throw new Error("Owner-stream reservation ownerPool and consumerPool are required.");
  const samePool = ownerPool === consumerPool;
  const now = config.now ?? nowIsoUtcTimestamp;
  const terminalKey = (binding: RequestTerminalBinding) => `${binding.consumerStoreId}:${binding.requestId}`;

  return {
    reserve: (input) => withPgTransaction(ownerPool, (client) => reserveInTransaction(client, input, now)),
    getReservation: async (reservationId) => {
      const result = await ownerPool.query<DbReservation>(
        `SELECT reservation_id, operation_id, owner_stream_id, purpose, resource_key,
                consumer_store_id, request_id, seal_version, store_incarnation, target,
                command_fingerprint, status, release_status
           FROM event_owner_stream_reservations WHERE reservation_id = $1`,
        [reservationId],
      );
      return result.rows[0] ? mapReservation(result.rows[0]) : undefined;
    },
    beginInvalidation: (ownerStreamId) =>
      withPgTransaction(ownerPool, (client) => beginInvalidationInTransaction(client, ownerStreamId, now)),
    driveInvalidation: (ownerStreamId) => driveInvalidation(ownerPool, consumerPool, ownerStreamId, now),
    openRequestTerminal: (binding) =>
      withPgTransaction(consumerPool, (client) => openTerminalInTransaction(client, binding)),
    commitRequestTerminal: (binding) =>
      commitTerminal(consumerPool, ownerPool, samePool, binding, terminalKey(binding), "COMMITTED"),
    abortRequestTerminal: (binding) =>
      commitTerminal(consumerPool, ownerPool, samePool, binding, terminalKey(binding), "ABORTED"),
    recordInboundEvidence: async (input) => {
      const result = await ownerPool.query<{
        evidence_id: string;
        resource_key: string;
        status: InboundEvidenceResult["status"];
      }>(
        `INSERT INTO event_owner_stream_inbound_evidence (evidence_id, resource_key, payload, status, recorded_at)
         VALUES ($1, $2, $3, CASE WHEN EXISTS (
           SELECT 1 FROM event_owner_stream_reservations WHERE resource_key = $2 AND status = 'OPEN'
         ) THEN 'PENDING' ELSE 'APPLIED' END, $4)
         ON CONFLICT (evidence_id) DO UPDATE SET evidence_id = EXCLUDED.evidence_id
         RETURNING evidence_id, resource_key, status`,
        [input.evidenceId, input.resourceKey, input.payload, now()],
      );
      const row = result.rows[0];
      if (!row) throw createEventStoreError("infrastructure_failure", "Inbound evidence row was not returned.");
      return { evidenceId: row.evidence_id, resourceKey: row.resource_key, status: row.status };
    },
  };
}

export async function reserveOwnerStreamInTransaction(
  client: PgQueryable,
  input: ReserveOwnerStreamInput,
  now: () => IsoUtcTimestamp = nowIsoUtcTimestamp,
): Promise<OwnerStreamReservation> {
  return reserveInTransaction(client, input, now);
}

async function reserveInTransaction(
  client: PgQueryable,
  input: ReserveOwnerStreamInput,
  now: () => IsoUtcTimestamp,
): Promise<OwnerStreamReservation> {
  assertOwnerStreamReservationInput(input);
  await client.query(OWNER_LOCK_SQL, [input.ownerStreamId]);
  const existing = await client.query<DbReservation>(
    "SELECT reservation_id, operation_id, owner_stream_id, purpose, resource_key, consumer_store_id, request_id, seal_version, store_incarnation, target, command_fingerprint, status, release_status FROM event_owner_stream_reservations WHERE reservation_id = $1",
    [input.reservationId],
  );
  if (existing.rows[0]) {
    const current = mapReservation(existing.rows[0]);
    if (
      current.operationId !== input.operationId ||
      current.ownerStreamId !== input.ownerStreamId ||
      current.purpose !== input.purpose ||
      current.resourceKey !== input.resourceKey ||
      current.consumer.storeId !== input.consumer.storeId ||
      current.consumer.requestId !== input.consumer.requestId ||
      current.seal.version !== input.seal.version ||
      current.seal.storeIncarnation !== input.seal.storeIncarnation ||
      current.commandFingerprint !== input.commandFingerprint ||
      JSON.stringify(current.target) !== JSON.stringify(input.target)
    )
      throw createEventStoreError("concurrency_conflict", "Reservation identity was reused with different data.");
    return current;
  }
  const invalidation = await client.query<{ status: string }>(
    "SELECT status FROM event_owner_stream_invalidations WHERE owner_stream_id = $1 AND status <> 'APPLIED'",
    [input.ownerStreamId],
  );
  if (invalidation.rows.length)
    throw createEventStoreError("concurrency_conflict", "Owner stream invalidation is pending.");
  const counts = await client.query<{ purpose_count: string; resource_count: string; live_count: string }>(
    `SELECT count(DISTINCT purpose)::text AS purpose_count,
            count(DISTINCT resource_key)::text AS resource_count,
            count(*) FILTER (WHERE resource_key = $2 AND status = 'OPEN')::text AS live_count
       FROM event_owner_stream_reservations
      WHERE operation_id = $1 AND status = 'OPEN'`,
    [input.operationId, input.resourceKey],
  );
  const count = counts.rows[0];
  if (!count) throw createEventStoreError("infrastructure_failure", "Reservation bounds could not be read.");
  if (Number(count.purpose_count) >= OWNER_STREAM_MAX_PURPOSES && !(await hasValue(client, "purpose", input)))
    throw createEventStoreError("concurrency_conflict", "Owner-stream reservation purpose bound exceeded.");
  if (Number(count.resource_count) >= OWNER_STREAM_MAX_RESOURCES && !(await hasValue(client, "resource_key", input)))
    throw createEventStoreError("concurrency_conflict", "Owner-stream reservation resource bound exceeded.");
  if (Number(count.live_count) >= OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE)
    throw createEventStoreError("concurrency_conflict", "Owner-stream reservation live-grant bound exceeded.");
  await client.query(
    `INSERT INTO event_owner_stream_reservations
      (reservation_id, operation_id, owner_stream_id, purpose, resource_key, consumer_store_id, request_id,
       seal_version, store_incarnation, target, command_fingerprint, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11)`,
    [
      input.reservationId,
      input.operationId,
      input.ownerStreamId,
      input.purpose,
      input.resourceKey,
      input.consumer.storeId,
      input.consumer.requestId,
      input.seal.version,
      input.seal.storeIncarnation,
      input.target,
      input.commandFingerprint,
      now(),
    ],
  );
  return { ...input, status: "OPEN" };
}

async function hasValue(
  client: PgQueryable,
  column: "purpose" | "resource_key",
  input: ReserveOwnerStreamInput,
): Promise<boolean> {
  const value = column === "purpose" ? input.purpose : input.resourceKey;
  const result = await client.query(
    `SELECT 1 FROM event_owner_stream_reservations WHERE operation_id = $1 AND ${column} = $2 AND status = 'OPEN' LIMIT 1`,
    [input.operationId, value],
  );
  return result.rows.length > 0;
}

async function beginInvalidationInTransaction(
  client: PgQueryable,
  ownerStreamId: string,
  now: () => IsoUtcTimestamp,
): Promise<InvalidationIntent> {
  await client.query(OWNER_LOCK_SQL, [ownerStreamId]);
  const prior = await client.query<{
    generation: string;
    status: InvalidationIntent["status"];
    affected_reservation_ids: string[];
  }>(
    "SELECT generation::text, status, affected_reservation_ids FROM event_owner_stream_invalidations WHERE owner_stream_id = $1",
    [ownerStreamId],
  );
  if (prior.rows[0] && prior.rows[0].status !== "APPLIED") return mapInvalidation(ownerStreamId, prior.rows[0]);
  const generation = Number(prior.rows[0]?.generation ?? 0) + 1;
  const affected = await client.query<{ reservation_id: string }>(
    "SELECT reservation_id FROM event_owner_stream_reservations WHERE owner_stream_id = $1 AND status = 'OPEN' ORDER BY reservation_id",
    [ownerStreamId],
  );
  const ids = affected.rows.map((row) => row.reservation_id);
  const result = await client.query<{
    generation: string;
    status: InvalidationIntent["status"];
    affected_reservation_ids: string[];
  }>(
    `INSERT INTO event_owner_stream_invalidations (owner_stream_id, generation, status, affected_reservation_ids, created_at, updated_at)
     VALUES ($1,$2,'PENDING',$3,$4,$4)
     ON CONFLICT (owner_stream_id) DO UPDATE SET
       generation = EXCLUDED.generation,
       status = 'PENDING',
       affected_reservation_ids = EXCLUDED.affected_reservation_ids,
       updated_at = EXCLUDED.updated_at
     RETURNING generation::text, status, affected_reservation_ids`,
    [ownerStreamId, generation, ids, now()],
  );
  return mapInvalidation(ownerStreamId, result.rows[0]!);
}

/** Caller-owned owner transaction entrypoint for a writer's invalidation intent. */
export function beginOwnerStreamInvalidationInTransaction(
  client: PgQueryable,
  ownerStreamId: string,
  now: () => IsoUtcTimestamp = nowIsoUtcTimestamp,
): Promise<InvalidationIntent> {
  return beginInvalidationInTransaction(client, ownerStreamId, now);
}

async function readInvalidation(pool: PgTransactionalPool, ownerStreamId: string): Promise<InvalidationIntent> {
  const result = await pool.query<{
    generation: string;
    status: InvalidationIntent["status"];
    affected_reservation_ids: string[];
  }>(
    "SELECT generation::text, status, affected_reservation_ids FROM event_owner_stream_invalidations WHERE owner_stream_id = $1",
    [ownerStreamId],
  );
  const row = result.rows[0];
  if (!row) throw createEventStoreError("concurrency_conflict", "Owner-stream invalidation has not been opened.");
  return mapInvalidation(ownerStreamId, row);
}

async function unresolvedTerminals(
  ownerPool: PgTransactionalPool,
  consumerPool: PgTransactionalPool,
  reservationIds: readonly string[],
): Promise<boolean> {
  if (reservationIds.length === 0) return false;
  const reservations = await ownerPool.query<{ consumer_store_id: string; request_id: string }>(
    "SELECT consumer_store_id, request_id FROM event_owner_stream_reservations WHERE reservation_id = ANY($1::text[])",
    [reservationIds],
  );
  for (const reservation of reservations.rows) {
    const terminal = await consumerPool.query<{ status: string }>(
      "SELECT status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2",
      [reservation.consumer_store_id, reservation.request_id],
    );
    if (!terminal.rows[0] || !["COMMITTED", "ABORTED"].includes(terminal.rows[0].status)) return true;
  }
  return false;
}

async function applyInvalidationInTransaction(
  client: PgQueryable,
  ownerStreamId: string,
  unresolved: boolean,
  now: () => IsoUtcTimestamp,
): Promise<InvalidationIntent> {
  await client.query(OWNER_LOCK_SQL, [ownerStreamId]);
  const result = await client.query<{
    generation: string;
    status: InvalidationIntent["status"];
    affected_reservation_ids: string[];
  }>(
    "SELECT generation::text, status, affected_reservation_ids FROM event_owner_stream_invalidations WHERE owner_stream_id = $1 FOR UPDATE",
    [ownerStreamId],
  );
  const row = result.rows[0];
  if (!row) throw createEventStoreError("concurrency_conflict", "Owner-stream invalidation has not been opened.");
  if (row.status === "APPLIED") return mapInvalidation(ownerStreamId, row);
  if (unresolved) {
    await client.query(
      "UPDATE event_owner_stream_invalidations SET status = 'ABORT-REQUESTED', updated_at = $2 WHERE owner_stream_id = $1",
      [ownerStreamId, now()],
    );
    return { ...mapInvalidation(ownerStreamId, row), status: "ABORT-REQUESTED" };
  }
  await client.query(
    "UPDATE event_owner_stream_invalidations SET status = 'APPLIED', updated_at = $2 WHERE owner_stream_id = $1",
    [ownerStreamId, now()],
  );
  return { ...mapInvalidation(ownerStreamId, row), status: "APPLIED" };
}

async function openTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
): Promise<RequestTerminal> {
  assertBinding(binding);
  await client.query(TERMINAL_LOCK_SQL, [binding.consumerStoreId, binding.requestId]);
  const prior = await client.query<DbTerminal>(
    "SELECT consumer_store_id, request_id, status, reservation_ids FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE",
    [binding.consumerStoreId, binding.requestId],
  );
  if (prior.rows[0]) return mapTerminal(prior.rows[0]);
  const result = await client.query<DbTerminal>(
    "INSERT INTO event_request_terminals (consumer_store_id, request_id, status, reservation_ids, created_at, updated_at) VALUES ($1,$2,'OPEN',$3,now(),now()) RETURNING consumer_store_id, request_id, status, reservation_ids",
    [binding.consumerStoreId, binding.requestId, binding.reservationIds],
  );
  return mapTerminal(result.rows[0]!);
}

export async function lockAndCommitRequestTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
): Promise<RequestTerminal> {
  assertBinding(binding);
  await client.query(TERMINAL_LOCK_SQL, [binding.consumerStoreId, binding.requestId]);
  return commitRequestTerminalInTransaction(
    client,
    binding,
    `${binding.consumerStoreId}:${binding.requestId}`,
    true,
    false,
  );
}

async function driveInvalidation(
  ownerPool: PgTransactionalPool,
  consumerPool: PgTransactionalPool,
  ownerStreamId: string,
  now: () => IsoUtcTimestamp,
): Promise<InvalidationIntent> {
  const intent = await readInvalidation(ownerPool, ownerStreamId);
  await reconcileReservations(ownerPool, consumerPool, intent.affectedReservationIds);
  const unresolved = await unresolvedTerminals(ownerPool, consumerPool, intent.affectedReservationIds);
  return withPgTransaction(ownerPool, (client) =>
    applyInvalidationInTransaction(client, ownerStreamId, unresolved, now),
  );
}

async function reconcileReservations(
  ownerPool: PgTransactionalPool,
  consumerPool: PgTransactionalPool,
  reservationIds: readonly string[],
): Promise<void> {
  const reservations = await ownerPool.query<{ reservation_id: string; consumer_store_id: string; request_id: string }>(
    "SELECT reservation_id, consumer_store_id, request_id FROM event_owner_stream_reservations WHERE reservation_id = ANY($1::text[]) AND status = 'OPEN'",
    [reservationIds],
  );
  for (const reservation of reservations.rows) {
    const terminal = await consumerPool.query<{ status: "COMMITTED" | "ABORTED" | "OPEN" }>(
      "SELECT status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2",
      [reservation.consumer_store_id, reservation.request_id],
    );
    const status = terminal.rows[0]?.status;
    if (status === "COMMITTED" || status === "ABORTED") {
      await ownerPool.query(
        "UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = $2, released_at = now() WHERE reservation_id = $1 AND status = 'OPEN'",
        [reservation.reservation_id, status],
      );
    }
  }
}

async function commitTerminal(
  consumerPool: PgTransactionalPool,
  ownerPool: PgTransactionalPool,
  samePool: boolean,
  binding: RequestTerminalBinding,
  key: string,
  status: "COMMITTED" | "ABORTED",
): Promise<RequestTerminal> {
  const terminal = await withPgTransaction(consumerPool, (client) =>
    status === "COMMITTED"
      ? commitRequestTerminalInTransaction(client, binding, key, false, samePool)
      : abortRequestTerminalInTransaction(client, binding, key, samePool),
  );
  if (!samePool) await releaseReservations(ownerPool, binding, status);
  return terminal;
}

async function releaseReservations(
  ownerPool: PgTransactionalPool,
  binding: RequestTerminalBinding,
  status: "COMMITTED" | "ABORTED",
): Promise<void> {
  await ownerPool.query(
    "UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = $2, released_at = now() WHERE reservation_id = ANY($1::text[]) AND consumer_store_id = $3 AND request_id = $4 AND status = 'OPEN'",
    [binding.reservationIds, status, binding.consumerStoreId, binding.requestId],
  );
}

async function commitRequestTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  _key: string,
  alreadyLocked = false,
  releaseReservations = true,
): Promise<RequestTerminal> {
  return transitionTerminalInTransaction(client, binding, "COMMITTED", alreadyLocked, releaseReservations);
}

async function abortRequestTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  _key: string,
  releaseReservations = true,
): Promise<RequestTerminal> {
  return transitionTerminalInTransaction(client, binding, "ABORTED", false, releaseReservations);
}

async function transitionTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  status: "COMMITTED" | "ABORTED",
  alreadyLocked: boolean,
  releaseReservations: boolean,
): Promise<RequestTerminal> {
  assertBinding(binding);
  if (!alreadyLocked) await client.query(TERMINAL_LOCK_SQL, [binding.consumerStoreId, binding.requestId]);
  const prior = await client.query<DbTerminal>(
    "SELECT consumer_store_id, request_id, status, reservation_ids FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE",
    [binding.consumerStoreId, binding.requestId],
  );
  const terminal = prior.rows[0];
  if (!terminal) throw createEventStoreError("concurrency_conflict", "Request terminal is not open.");
  if (terminal.status !== "OPEN") {
    if (terminal.status === status) return mapTerminal(terminal);
    throw createEventStoreError("concurrency_conflict", "Request terminal is already final.");
  }
  if (JSON.stringify(terminal.reservation_ids) !== JSON.stringify(binding.reservationIds))
    throw createEventStoreError("concurrency_conflict", "Request terminal reservation identity does not match.");
  await client.query(
    "UPDATE event_request_terminals SET status = $3, updated_at = now() WHERE consumer_store_id = $1 AND request_id = $2 AND status = 'OPEN'",
    [binding.consumerStoreId, binding.requestId, status],
  );
  if (releaseReservations)
    await client.query(
      "UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = $2, released_at = now() WHERE reservation_id = ANY($1::text[]) AND consumer_store_id = $3 AND request_id = $4 AND status = 'OPEN'",
      [terminal.reservation_ids, status, binding.consumerStoreId, binding.requestId],
    );
  return { ...mapTerminal(terminal), status };
}

function assertBinding(binding: RequestTerminalBinding): void {
  if (
    !binding.consumerStoreId ||
    !binding.requestId ||
    binding.reservationIds.length === 0 ||
    new Set(binding.reservationIds).size !== binding.reservationIds.length
  )
    throw createEventStoreError("concurrency_conflict", "Request terminal binding is incomplete.");
}
function mapReservation(row: DbReservation): OwnerStreamReservation {
  return {
    reservationId: row.reservation_id,
    operationId: row.operation_id,
    ownerStreamId: row.owner_stream_id,
    purpose: row.purpose,
    resourceKey: row.resource_key,
    consumer: { storeId: row.consumer_store_id, requestId: row.request_id },
    seal: { version: Number(row.seal_version), storeIncarnation: row.store_incarnation },
    target: row.target as Record<string, unknown>,
    commandFingerprint: row.command_fingerprint,
    status: row.status,
    ...(row.release_status ? { releaseStatus: row.release_status } : {}),
  };
}
function mapTerminal(row: DbTerminal): RequestTerminal {
  return {
    consumerStoreId: row.consumer_store_id,
    requestId: row.request_id,
    status: row.status,
    reservationIds: [...row.reservation_ids],
  };
}
function mapInvalidation(
  ownerStreamId: string,
  row: { generation: string; status: InvalidationIntent["status"]; affected_reservation_ids: string[] },
): InvalidationIntent {
  return {
    ownerStreamId,
    generation: Number(row.generation),
    status: row.status,
    affectedReservationIds: [...row.affected_reservation_ids],
  };
}

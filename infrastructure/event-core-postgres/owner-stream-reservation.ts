import { randomUUID } from "node:crypto";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import {
  assertOwnerStreamReservationInput,
  assertRequestTerminalBinding,
  reservationIdentity,
  reservationInput,
  sameRequestTerminalBinding,
  terminalOwnsReservation,
  OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE,
  OWNER_STREAM_MAX_PURPOSES,
  OWNER_STREAM_MAX_RESOURCES,
  type InboundEvidenceInput,
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
import { boundStep, withConfigurationEpochTransaction } from "./configuration-epoch";
import type { PgQueryable, PgTransactionalPool, PgPoolClient } from "./types";

function withPgTransaction<T>(pool: PgTransactionalPool, work: (client: PgPoolClient) => Promise<T>): Promise<T> {
  return withConfigurationEpochTransaction(pool, async (client) => {
    await boundStep(client);
    return work(client);
  });
}
function participationQuery<Row>(pool: PgTransactionalPool, sql: string, values?: readonly unknown[]) {
  return withPgTransaction(pool, (client) => client.query<Row>(sql, values));
}

type DbReservation = Readonly<{
  reservation_id: string;
  operation_id: string;
  owner_stream_id: string;
  purpose: string;
  resource_key: string;
  consumer_store_id: string;
  consumer_incarnation: string;
  request_id: string;
  seal_version: string | number;
  store_incarnation: string;
  target: Record<string, unknown>;
  command_fingerprint: string;
  status: "OPEN" | "RELEASED";
  release_status: "COMMITTED" | "ABORTED" | null;
}>;
type DbIntent = Readonly<{
  generation: string;
  status: InvalidationIntent["status"];
  affected_reservation_ids: string[];
}>;
type DbTerminal = Readonly<{ binding: RequestTerminalBinding; status: RequestTerminal["status"] }>;
type DbEvidence = Readonly<{
  evidence_id: string;
  resource_key: string;
  payload: Record<string, unknown>;
  status: InboundEvidenceResult["status"];
}>;
export type PostgresOwnerStreamReservationStoreConfig = Readonly<{
  ownerPool: PgTransactionalPool;
  consumerPool: PgTransactionalPool;
  /** Effective writer changes and APPLIED are committed in this same owner transaction. */
  applyInvalidation: (client: PgQueryable, intent: InvalidationIntent) => Promise<void>;
  applyInboundEvidence: (client: PgQueryable, evidence: InboundEvidenceInput) => Promise<void>;
  now?: () => IsoUtcTimestamp;
}>;
const OWNER_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('owner_stream:' || $1::text, 0))";
const OPERATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('owner_operation:' || $1::text, 0))";
const RESOURCE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('owner_resource:' || $1::text, 0))";
const TERMINAL_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('request_terminal:' || $1::text || ':' || $2::text, 0))";
const RESERVATION_COLUMNS =
  "reservation_id, operation_id, owner_stream_id, purpose, resource_key, consumer_store_id, consumer_incarnation, request_id, seal_version, store_incarnation, target, command_fingerprint, status, release_status";

/** Install only on the consumer that witnesses never-opened requests. */
export const requestTerminalWitnessSchemaSql = `
CREATE TABLE IF NOT EXISTS event_request_terminal_witnesses (
  consumer_store_id text NOT NULL,
  request_id text NOT NULL,
  consumer_incarnation text NOT NULL,
  token uuid,
  status text NOT NULL CHECK (status IN ('VIRGIN', 'SEEN', 'CLAIMED', 'ISSUING', 'ISSUED')),
  binding jsonb,
  PRIMARY KEY (consumer_store_id, request_id),
  CHECK (status = 'SEEN' OR token IS NOT NULL),
  CHECK ((binding IS NOT NULL) = (status IN ('CLAIMED', 'ISSUING', 'ISSUED')))
);

CREATE FUNCTION event_fence_request_terminal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE witness event_request_terminal_witnesses%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('request_terminal:' || NEW.consumer_store_id || ':' || NEW.request_id, 0));
  SELECT * INTO witness FROM event_request_terminal_witnesses
    WHERE consumer_store_id = NEW.consumer_store_id AND request_id = NEW.request_id FOR UPDATE;
  IF witness.status IN ('CLAIMED', 'ISSUED') OR
    (witness.status = 'ISSUING' AND (NEW.status <> 'ABORTED' OR NEW.binding IS DISTINCT FROM witness.binding)) THEN
    RAISE EXCEPTION 'Request terminal first insert is fenced by recovery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION event_witness_request_terminal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE event_request_terminal_witnesses SET status = 'ISSUED'
    WHERE consumer_store_id = NEW.consumer_store_id AND request_id = NEW.request_id
      AND status = 'ISSUING' AND NEW.status = 'ABORTED' AND binding = NEW.binding;
  IF FOUND THEN RETURN NEW; END IF;

  INSERT INTO event_request_terminal_witnesses (consumer_store_id, request_id, consumer_incarnation, status)
    VALUES (NEW.consumer_store_id, NEW.request_id, COALESCE(NEW.binding->>'consumerIncarnation', ''), 'SEEN')
    ON CONFLICT (consumer_store_id, request_id) DO UPDATE SET status = 'SEEN'
      WHERE event_request_terminal_witnesses.status IN ('VIRGIN', 'SEEN');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request terminal insert lost its witness fence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION event_require_request_terminal_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_request_terminal_witnesses w JOIN event_request_terminals t
      USING (consumer_store_id, request_id)
      WHERE w.consumer_store_id = NEW.consumer_store_id AND w.request_id = NEW.request_id
        AND w.status = 'ISSUED' AND w.binding = NEW.binding AND t.status = 'ABORTED' AND t.binding = NEW.binding) THEN
    RAISE EXCEPTION 'Request terminal publication did not seal' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER event_fence_request_terminal_insert BEFORE INSERT ON event_request_terminals
  FOR EACH ROW EXECUTE FUNCTION event_fence_request_terminal_insert();
CREATE TRIGGER event_witness_request_terminal_insert AFTER INSERT ON event_request_terminals
  FOR EACH ROW EXECUTE FUNCTION event_witness_request_terminal_insert();
CREATE CONSTRAINT TRIGGER event_require_request_terminal_publication
  AFTER INSERT OR UPDATE ON event_request_terminal_witnesses DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'ISSUING') EXECUTE FUNCTION event_require_request_terminal_publication();
`;

type TerminalWitness = Readonly<{
  token: string | null;
  consumer_incarnation: string;
  status: "VIRGIN" | "SEEN" | "CLAIMED" | "ISSUING" | "ISSUED";
  binding: RequestTerminalBinding | null;
}>;
function conflict(message: string): never {
  throw createEventStoreError("concurrency_conflict", message);
}

async function lockWitness(client: PgQueryable, binding: RequestTerminalBinding) {
  const key = [binding.consumerStoreId, binding.requestId] as const;
  await client.query(TERMINAL_LOCK_SQL, key);
  await assertConsumerIdentity(client, binding, true);
  const witness = await client.query<TerminalWitness>(
    `SELECT token, consumer_incarnation, status, binding FROM event_request_terminal_witnesses
     WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE`,
    key,
  );
  const terminal = await client.query<DbTerminal>(
    `SELECT binding, status FROM event_request_terminals
     WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE`,
    key,
  );
  return { key, witness: witness.rows[0], terminal: terminal.rows[0] };
}

export function registerRequestTerminalWitness(pool: PgTransactionalPool, binding: RequestTerminalBinding) {
  return withPgTransaction(pool, async (client) => {
    const { key, witness, terminal } = await lockWitness(client, binding);
    if (terminal) return undefined;
    if (witness)
      return witness.status === "VIRGIN" && witness.consumer_incarnation === binding.consumerIncarnation
        ? (witness.token ?? undefined)
        : undefined;
    const inserted = await client.query<{ token: string }>(
      `INSERT INTO event_request_terminal_witnesses (consumer_store_id, request_id, consumer_incarnation, token, status)
       VALUES ($1,$2,$3,$4,'VIRGIN') ON CONFLICT DO NOTHING RETURNING token`,
      [...key, binding.consumerIncarnation, randomUUID()],
    );
    return inserted.rows[0]?.token;
  });
}

/** Advance one consumer-local recovery step, returning only committed facts. */
export function advanceRequestTerminalRecovery(
  pool: PgTransactionalPool,
  binding: RequestTerminalBinding,
  token: string,
  decision: "PREPARED" | "RECOVERING",
) {
  return withPgTransaction(pool, async (client) => {
    const { key, witness, terminal } = await lockWitness(client, binding);
    if (witness?.token !== token || witness.consumer_incarnation !== binding.consumerIncarnation) return;
    if (witness.status === "VIRGIN" && !terminal && decision === "PREPARED") {
      const claimed = await client.query(
        `UPDATE event_request_terminal_witnesses SET status = 'CLAIMED', binding = $4
         WHERE consumer_store_id = $1 AND request_id = $2 AND token = $3 AND status = 'VIRGIN'
           AND clock_timestamp() >= $5::timestamptz`,
        [...key, token, binding, binding.preparationDeadline],
      );
      if (claimed.rowCount === 1) return "CLAIMED";
      return;
    }
    if (!witness.binding || !sameRequestTerminalBinding(witness.binding, binding)) return;
    if (
      witness.status === "ISSUED" &&
      decision === "RECOVERING" &&
      terminal?.status === "ABORTED" &&
      sameRequestTerminalBinding(terminal.binding, binding)
    )
      return "ISSUED";
    if (witness.status !== "CLAIMED" || terminal) return;
    if (decision === "PREPARED") return "CLAIMED";

    const issuing = await client.query(
      `UPDATE event_request_terminal_witnesses SET status = 'ISSUING'
       WHERE consumer_store_id = $1 AND request_id = $2 AND token = $3 AND status = 'CLAIMED' AND binding = $4`,
      [...key, token, binding],
    );
    if (issuing.rowCount !== 1) return;
    const inserted = await client.query<DbTerminal>(
      `INSERT INTO event_request_terminals (consumer_store_id, request_id, status, binding, created_at, updated_at)
       VALUES ($1,$2,'ABORTED',$3,now(),now()) RETURNING binding, status`,
      [...key, binding],
    );
    const sealed = await client.query(
      `SELECT 1 FROM event_request_terminal_witnesses WHERE consumer_store_id = $1 AND request_id = $2
         AND token = $3 AND binding = $4 AND status = 'ISSUED'`,
      [...key, token, binding],
    );
    if (
      inserted.rowCount !== 1 ||
      inserted.rows[0]?.status !== "ABORTED" ||
      !sameRequestTerminalBinding(inserted.rows[0].binding, binding) ||
      sealed.rowCount !== 1
    )
      conflict("Recovery terminal publication was not sealed.");
    return "PUBLISHED";
  });
}

export async function drainAbortedOwnerReservationsInTransaction(
  client: PgQueryable,
  ownerStoreId: string,
  members: readonly ReserveOwnerStreamInput[],
  allowNeverReserved: boolean,
) {
  if (!members.length) return true;
  await boundStep(client);
  await lockOwnerStreamInvalidationsInTransaction(
    client,
    members.map(({ ownerStreamId }) => ownerStreamId),
  );
  const identity = await client.query<{ store_id: string; incarnation: string }>(
    "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true FOR SHARE",
  );
  const store = identity.rows[0];
  if (
    identity.rows.length !== 1 ||
    store?.store_id !== ownerStoreId ||
    members.some(({ seal }) => seal.storeIncarnation !== store.incarnation)
  )
    return false;
  const open = [];
  for (const input of members) {
    const result = await client.query<DbReservation>(
      `SELECT ${RESERVATION_COLUMNS} FROM event_owner_stream_reservations WHERE reservation_id = $1 FOR UPDATE`,
      [input.reservationId],
    );
    const row = result.rows[0];
    if (!row && allowNeverReserved) continue;
    if (!row || reservationIdentity(reservationInput(mapReservation(row))) !== reservationIdentity(input)) return false;
    if (row.status === "OPEN" && row.release_status === null) open.push(input.reservationId);
    else if (row.status !== "RELEASED" || row.release_status !== "ABORTED") return false;
  }
  if (open.length) {
    const result = await client.query(
      `UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = 'ABORTED', released_at = now()
       WHERE reservation_id = ANY($1::text[]) AND status = 'OPEN'`,
      [open],
    );
    if (result.rowCount !== open.length) conflict("Exact owner drain did not release every open member.");
  }
  return true;
}

export function createPostgresOwnerStreamReservationStore(
  config: PostgresOwnerStreamReservationStoreConfig,
): OwnerStreamReservationStore {
  const { ownerPool, consumerPool } = config;
  const now = config.now ?? nowIsoUtcTimestamp;
  return {
    reserve: (input) => withPgTransaction(ownerPool, (client) => reserveOwnerStreamInTransaction(client, input, now)),
    getReservation: async (id) => {
      const result = await participationQuery<DbReservation>(
        ownerPool,
        `SELECT ${RESERVATION_COLUMNS} FROM event_owner_stream_reservations WHERE reservation_id = $1`,
        [id],
      );
      return result.rows[0] ? mapReservation(result.rows[0]) : undefined;
    },
    beginInvalidation: (id) =>
      withPgTransaction(ownerPool, (client) => beginOwnerStreamInvalidationInTransaction(client, id, now)),
    driveInvalidation: (id) => driveInvalidation(config, id),
    openRequestTerminal: async (binding) => {
      assertRequestTerminalBinding(binding);
      for (const r of binding.reservations) {
        const result = await participationQuery<DbReservation>(
          ownerPool,
          `SELECT ${RESERVATION_COLUMNS} FROM event_owner_stream_reservations WHERE reservation_id = $1`,
          [r.reservationId],
        );
        if (
          !result.rows[0] ||
          result.rows[0].status !== "OPEN" ||
          reservationIdentity(reservationInput(mapReservation(result.rows[0]))) !== reservationIdentity(r)
        )
          conflict("Request preparation is incomplete.");
      }
      return withPgTransaction(consumerPool, (client) => openRequestTerminalInTransaction(client, binding));
    },
    abortRequestTerminal: (binding) =>
      withPgTransaction(consumerPool, async (client) => {
        await openRequestTerminalInTransaction(client, binding, "ABORTED");
        return transitionTerminal(client, binding, "ABORTED");
      }),
    abortPreparationDeadline: (binding) =>
      withPgTransaction(consumerPool, async (client) => {
        const clock = await client.query<{ expired: boolean }>(
          "SELECT clock_timestamp() >= $1::timestamptz AS expired",
          [binding.preparationDeadline],
        );
        if (clock.rows[0]?.expired) {
          await openRequestTerminalInTransaction(client, binding, "ABORTED");
          return transitionTerminal(client, binding, "ABORTED");
        }
        return readLockedTerminal(client, binding);
      }),
    recordInboundEvidence: (input) =>
      withPgTransaction(ownerPool, async (client) => {
        if (!input.evidenceId || !input.resourceKey) conflict("Inbound evidence identity is incomplete.");
        reservationIdentity(input.payload);
        await client.query(RESOURCE_LOCK_SQL, [input.resourceKey]);
        const result = await client.query<DbEvidence>(
          `INSERT INTO event_owner_stream_inbound_evidence (evidence_id, resource_key, payload, status, recorded_at)
         VALUES ($1,$2,$3,'PENDING',$4) ON CONFLICT (evidence_id) DO UPDATE SET evidence_id = EXCLUDED.evidence_id
         RETURNING evidence_id, resource_key, payload, status`,
          [input.evidenceId, input.resourceKey, input.payload, now()],
        );
        const row = result.rows[0]!;
        if (
          row.resource_key !== input.resourceKey ||
          reservationIdentity(row.payload) !== reservationIdentity(input.payload)
        )
          conflict("Inbound evidence identity was reused.");
        return mapEvidence(row);
      }),
    settleInboundEvidence: (id) => settleInboundEvidence(config, id),
  };
}

/** Owner writers must take this lock before changing canonical owner state. */
export async function reserveOwnerStreamInTransaction(
  client: PgQueryable,
  input: ReserveOwnerStreamInput,
  now = nowIsoUtcTimestamp,
  readSeal = readOwnerStreamSealInTransaction,
): Promise<OwnerStreamReservation> {
  assertOwnerStreamReservationInput(input);
  await boundStep(client);
  // Owner -> operation -> resource: serialize every distinct bound, including cross-stream attempts.
  await client.query(OWNER_LOCK_SQL, [input.ownerStreamId]);
  await client.query(OPERATION_LOCK_SQL, [input.operationId]);
  await client.query(RESOURCE_LOCK_SQL, [input.resourceKey]);
  const existing = await client.query<DbReservation>(
    `SELECT ${RESERVATION_COLUMNS} FROM event_owner_stream_reservations WHERE reservation_id = $1`,
    [input.reservationId],
  );
  if (existing.rows[0]) {
    const prior = mapReservation(existing.rows[0]);
    if (reservationIdentity(reservationInput(prior)) !== reservationIdentity(input))
      conflict("Reservation identity was reused.");
    return prior;
  }
  const seal = await readSeal(client, input.ownerStreamId);
  if (seal?.storeIncarnation !== input.seal.storeIncarnation || seal.version !== input.seal.version)
    conflict("Owner-stream seal is not current.");
  const pending = await client.query(
    `SELECT 1 FROM event_owner_stream_invalidations WHERE owner_stream_id = $1 AND status <> 'APPLIED'
     UNION ALL SELECT 1 FROM event_owner_stream_inbound_evidence WHERE resource_key = $2 AND status <> 'APPLIED' LIMIT 1`,
    [input.ownerStreamId, input.resourceKey],
  );
  if (pending.rows.length) conflict("Owner stream invalidation or inbound evidence settlement is pending.");
  const counts = await client.query<{ purposes: string[]; resources: string[]; live_count: string }>(
    `SELECT ARRAY(SELECT DISTINCT purpose FROM event_owner_stream_reservations WHERE operation_id = $1 AND status = 'OPEN') AS purposes,
            ARRAY(SELECT DISTINCT resource_key FROM event_owner_stream_reservations WHERE operation_id = $1 AND status = 'OPEN') AS resources,
            (SELECT count(*)::text FROM event_owner_stream_reservations WHERE resource_key = $2 AND status = 'OPEN') AS live_count`,
    [input.operationId, input.resourceKey],
  );
  const count = counts.rows[0]!;
  if (!count.purposes.includes(input.purpose) && count.purposes.length >= OWNER_STREAM_MAX_PURPOSES)
    conflict("Owner-stream reservation purpose bound exceeded.");
  if (!count.resources.includes(input.resourceKey) && count.resources.length >= OWNER_STREAM_MAX_RESOURCES)
    conflict("Owner-stream reservation resource bound exceeded.");
  if (Number(count.live_count) >= OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE)
    conflict("Owner-stream reservation live-grant bound exceeded.");
  await client.query(
    `INSERT INTO event_owner_stream_reservations
     (reservation_id, operation_id, owner_stream_id, purpose, resource_key, consumer_store_id, consumer_incarnation, request_id,
      seal_version, store_incarnation, target, command_fingerprint, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'OPEN',$13)`,
    [
      input.reservationId,
      input.operationId,
      input.ownerStreamId,
      input.purpose,
      input.resourceKey,
      input.consumer.storeId,
      input.consumer.incarnation,
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

async function readOwnerStreamSealInTransaction(client: PgQueryable, streamId: string) {
  const result = await client.query<{ incarnation: string; current_version: string }>(
    `SELECT identity.incarnation, streams.current_version::text FROM event_configuration_store_identity identity
     JOIN event_store_streams streams ON streams.stream_id = $1 WHERE identity.singleton = true FOR UPDATE OF streams`,
    [streamId],
  );
  const row = result.rows[0];
  return row && { storeIncarnation: row.incarnation, version: Number(row.current_version) };
}

export async function lockOwnerStreamInvalidationsInTransaction(client: PgQueryable, keys: readonly string[]) {
  await boundStep(client);
  for (const key of [...new Set(keys)].sort()) await client.query(OWNER_LOCK_SQL, [key]);
}

/** Persists the closed generation inside the writer's own transaction. */
export async function beginOwnerStreamInvalidationInTransaction(
  client: PgQueryable,
  ownerStreamId: string,
  now = nowIsoUtcTimestamp,
): Promise<InvalidationIntent> {
  await boundStep(client);
  await client.query(OWNER_LOCK_SQL, [ownerStreamId]);
  const prior = await readIntent(client, ownerStreamId);
  if (prior && prior.status !== "APPLIED") return prior;
  const affected = await client.query<{ reservation_id: string }>(
    "SELECT reservation_id FROM event_owner_stream_reservations WHERE owner_stream_id = $1 AND status = 'OPEN' ORDER BY reservation_id",
    [ownerStreamId],
  );
  const result = await client.query<DbIntent>(
    `INSERT INTO event_owner_stream_invalidations (owner_stream_id, generation, status, affected_reservation_ids, created_at, updated_at)
     VALUES ($1,$2,'PENDING',$3,$4,$4) ON CONFLICT (owner_stream_id) DO UPDATE SET
     generation = EXCLUDED.generation, status = EXCLUDED.status, affected_reservation_ids = EXCLUDED.affected_reservation_ids, updated_at = EXCLUDED.updated_at
     RETURNING generation::text, status, affected_reservation_ids`,
    [ownerStreamId, (prior?.generation ?? 0) + 1, affected.rows.map((r) => r.reservation_id), now()],
  );
  return mapIntent(ownerStreamId, result.rows[0]!);
}
async function readIntent(client: PgQueryable, id: string): Promise<InvalidationIntent | undefined> {
  const result = await client.query<DbIntent>(
    "SELECT generation::text, status, affected_reservation_ids FROM event_owner_stream_invalidations WHERE owner_stream_id = $1",
    [id],
  );
  return result.rows[0] ? mapIntent(id, result.rows[0]) : undefined;
}
async function driveInvalidation(
  config: PostgresOwnerStreamReservationStoreConfig,
  id: string,
): Promise<InvalidationIntent> {
  const intent = await settleOriginalTerminals(config.ownerPool, config.consumerPool, id);
  return withPgTransaction(config.ownerPool, (client) =>
    applyOwnerStreamInvalidationInTransaction(client, intent, config.applyInvalidation),
  );
}

/** Settle the recorded membership without applying or reopening the owner's writer generation. */
export async function settleOriginalTerminals(
  ownerPool: PgTransactionalPool,
  consumerPool: PgTransactionalPool | undefined,
  id: string,
): Promise<InvalidationIntent> {
  const intent = await withPgTransaction(ownerPool, async (client) => {
    await client.query(OWNER_LOCK_SQL, [id]);
    const current = await readIntent(client, id);
    if (!current) return conflict("Owner-stream invalidation has not been opened.");
    if (current.status !== "APPLIED")
      await client.query(
        "UPDATE event_owner_stream_invalidations SET status = 'ABORT-REQUESTED', updated_at = now() WHERE owner_stream_id = $1",
        [id],
      );
    return current;
  });
  if (intent.status === "APPLIED" || !consumerPool) return intent;
  // All consumer I/O, including the abort CAS, happens outside owner transactions/locks.
  const rows = await participationQuery<DbReservation>(
    ownerPool,
    `SELECT ${RESERVATION_COLUMNS} FROM event_owner_stream_reservations WHERE reservation_id = ANY($1::text[])`,
    [intent.affectedReservationIds],
  );
  for (const row of rows.rows) {
    const reservation = mapReservation(row);
    if (reservation.status === "RELEASED") continue;
    let terminal: RequestTerminal | undefined;
    try {
      const result = await participationQuery<DbTerminal>(
        consumerPool,
        `SELECT binding, status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2
        AND EXISTS (SELECT 1 FROM event_configuration_store_identity WHERE singleton = true AND store_id = $1 AND incarnation = $3)`,
        [reservation.consumer.storeId, reservation.consumer.requestId, reservation.consumer.incarnation],
      );
      if (!result.rows[0]) continue;
      terminal = mapTerminal(result.rows[0]);
      if (!terminalOwnsReservation(terminal, reservation)) continue;
      if (terminal.status === "OPEN")
        terminal = await withPgTransaction(consumerPool, (client) => transitionTerminal(client, terminal!, "ABORTED"));
    } catch {
      // Unavailable and lost replies are unknown; durable state remains blocking.
      continue;
    }
    if (terminal.status !== "OPEN" && terminalOwnsReservation(terminal, reservation))
      await participationQuery(
        ownerPool,
        "UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = $2, released_at = now() WHERE reservation_id = $1 AND status = 'OPEN'",
        [reservation.reservationId, terminal.status],
      );
  }
  return intent;
}

/** Generation-fenced final application. The callback must write only through this owner transaction. */
export async function applyOwnerStreamInvalidationInTransaction(
  client: PgQueryable,
  expected: InvalidationIntent,
  apply: PostgresOwnerStreamReservationStoreConfig["applyInvalidation"],
): Promise<InvalidationIntent> {
  await boundStep(client);
  await client.query(OWNER_LOCK_SQL, [expected.ownerStreamId]);
  const current = await readIntent(client, expected.ownerStreamId);
  if (
    !current ||
    current.generation !== expected.generation ||
    reservationIdentity(current.affectedReservationIds) !== reservationIdentity(expected.affectedReservationIds)
  )
    conflict("Invalidation generation changed during settlement.");
  if (current.status === "APPLIED") return current;
  const released = await client.query<{ reservation_id: string }>(
    "SELECT reservation_id FROM event_owner_stream_reservations WHERE reservation_id = ANY($1::text[]) AND status = 'RELEASED' AND release_status IN ('COMMITTED','ABORTED')",
    [current.affectedReservationIds],
  );
  if (released.rows.length !== current.affectedReservationIds.length) return { ...current, status: "ABORT-REQUESTED" };
  await apply(client, current);
  await client.query(
    "UPDATE event_owner_stream_invalidations SET status = 'APPLIED', updated_at = now() WHERE owner_stream_id = $1 AND generation = $2",
    [current.ownerStreamId, current.generation],
  );
  return { ...current, status: "APPLIED" };
}

async function assertConsumerIdentity(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  lock = false,
): Promise<void> {
  assertRequestTerminalBinding(binding);
  const result = await client.query<{ store_id: string; incarnation: string }>(
    `SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true${lock ? " FOR SHARE" : ""}`,
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0]!.store_id !== binding.consumerStoreId ||
    result.rows[0]!.incarnation !== binding.consumerIncarnation
  )
    conflict("Request terminal consumer incarnation does not match.");
}
export async function openRequestTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  initialStatus: "OPEN" | "ABORTED" = "OPEN",
): Promise<RequestTerminal> {
  await assertConsumerIdentity(client, binding);
  await client.query(TERMINAL_LOCK_SQL, [binding.consumerStoreId, binding.requestId]);
  const prior = await client.query<DbTerminal>(
    "SELECT binding, status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE",
    [binding.consumerStoreId, binding.requestId],
  );
  if (prior.rows[0]) {
    const terminal = mapTerminal(prior.rows[0]);
    if (!sameRequestTerminalBinding(terminal, binding)) conflict("Request terminal identity was reused.");
    if (initialStatus === "OPEN" && terminal.status === "OPEN") await assertExactPreparationTime(client, binding);
    return terminal;
  }
  if (initialStatus === "OPEN") await assertExactPreparationTime(client, binding);
  const result = await client.query<DbTerminal>(
    "INSERT INTO event_request_terminals (consumer_store_id, request_id, status, binding, created_at, updated_at) VALUES ($1,$2,$4,$3,now(),now()) ON CONFLICT (consumer_store_id, request_id) DO UPDATE SET request_id = EXCLUDED.request_id RETURNING binding, status",
    [binding.consumerStoreId, binding.requestId, binding, initialStatus],
  );
  const terminal = mapTerminal(result.rows[0]!);
  if (!sameRequestTerminalBinding(terminal, binding)) conflict("Request terminal identity was reused.");
  return terminal;
}
async function readLockedTerminal(client: PgQueryable, binding: RequestTerminalBinding): Promise<RequestTerminal> {
  await boundStep(client);
  await assertConsumerIdentity(client, binding);
  await client.query(TERMINAL_LOCK_SQL, [binding.consumerStoreId, binding.requestId]);
  const result = await client.query<DbTerminal>(
    "SELECT binding, status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2 FOR UPDATE",
    [binding.consumerStoreId, binding.requestId],
  );
  if (!result.rows[0]) return conflict("Request terminal is not open.");
  const terminal = mapTerminal(result.rows[0]);
  if (!sameRequestTerminalBinding(terminal, binding)) conflict("Request terminal identity does not match.");
  return terminal;
}
async function transitionTerminal(
  client: PgQueryable,
  binding: RequestTerminalBinding,
  status: "COMMITTED" | "ABORTED",
): Promise<RequestTerminal> {
  const prior = await readLockedTerminal(client, binding);
  if (prior.status !== "OPEN") {
    if (status === "ABORTED") return prior;
    return conflict("Request terminal is already final.");
  }
  if (status === "COMMITTED") await assertExactPreparationTime(client, binding);
  const updated = await client.query(
    "UPDATE event_request_terminals SET status = $3, updated_at = now() WHERE consumer_store_id = $1 AND request_id = $2 AND status = 'OPEN'",
    [binding.consumerStoreId, binding.requestId, status],
  );
  if (updated.rowCount !== 1) conflict("Request terminal transition is uncertain.");
  return { ...prior, status };
}

export async function assertExactPreparationTime(client: PgQueryable, binding: RequestTerminalBinding) {
  if (binding.preparationNotBefore === undefined) return;
  const result = await client.query<{ permitted: boolean }>(
    `SELECT checked.at >= $1::timestamptz AND checked.at < $2::timestamptz AS permitted
     FROM (SELECT clock_timestamp() AS at) checked
     WHERE EXISTS (SELECT 1 FROM event_configuration_store_identity
       WHERE singleton = true AND store_id = $3 AND incarnation = $4)`,
    [binding.preparationNotBefore, binding.preparationDeadline, binding.consumerStoreId, binding.consumerIncarnation],
  );
  if (result.rows[0]?.permitted !== true) conflict("Exact preparation is outside its DB-time window.");
}

export async function lockOpenRequestTerminalInTransaction(client: PgQueryable, binding: RequestTerminalBinding) {
  if ((await readLockedTerminal(client, binding)).status !== "OPEN") conflict("Request terminal is already final.");
}
/** EventStore adapter internal: COMMITTED is never a standalone store operation. */
export function lockAndCommitRequestTerminalInTransaction(
  client: PgQueryable,
  binding: RequestTerminalBinding,
): Promise<RequestTerminal> {
  return transitionTerminal(client, binding, "COMMITTED");
}

async function settleInboundEvidence(
  config: PostgresOwnerStreamReservationStoreConfig,
  id: string,
): Promise<InboundEvidenceResult> {
  const before = await participationQuery<DbEvidence>(
    config.ownerPool,
    "SELECT evidence_id, resource_key, payload, status FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1",
    [id],
  );
  if (!before.rows[0]) return conflict("Inbound evidence is missing.");
  if (before.rows[0].status === "APPLIED") return mapEvidence(before.rows[0]);
  const owners = await participationQuery<{ owner_stream_id: string }>(
    config.ownerPool,
    `SELECT DISTINCT owner_stream_id FROM event_owner_stream_reservations WHERE resource_key = $1 AND status = 'OPEN'
     UNION SELECT i.owner_stream_id FROM event_owner_stream_invalidations i JOIN event_owner_stream_reservations r
     ON r.reservation_id = ANY(i.affected_reservation_ids) WHERE r.resource_key = $1 AND i.status <> 'APPLIED' ORDER BY owner_stream_id`,
    [before.rows[0].resource_key],
  );
  for (const owner of owners.rows) {
    const needed = await withPgTransaction(config.ownerPool, async (client) => {
      // Revalidate the discovery hint in the same owner -> resource order as reservation admission.
      await client.query(OWNER_LOCK_SQL, [owner.owner_stream_id]);
      await client.query(RESOURCE_LOCK_SQL, [before.rows[0]!.resource_key]);
      const evidence = await client.query<DbEvidence>(
        "SELECT evidence_id, resource_key, payload, status FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1 FOR UPDATE",
        [id],
      );
      if (evidence.rows[0]!.status === "APPLIED") return false;
      const pending = await client.query(
        `SELECT 1 FROM event_owner_stream_reservations WHERE resource_key = $1 AND owner_stream_id = $2 AND status = 'OPEN'
         UNION ALL SELECT 1 FROM event_owner_stream_invalidations i JOIN event_owner_stream_reservations r
         ON r.reservation_id = ANY(i.affected_reservation_ids) WHERE r.resource_key = $1 AND i.owner_stream_id = $2 AND i.status <> 'APPLIED' LIMIT 1`,
        [before.rows[0]!.resource_key, owner.owner_stream_id],
      );
      if (!pending.rows.length) return false;
      await beginOwnerStreamInvalidationInTransaction(client, owner.owner_stream_id);
      return true;
    });
    if (needed) await driveInvalidation(config, owner.owner_stream_id);
  }
  return withPgTransaction(config.ownerPool, async (client) => {
    await client.query(RESOURCE_LOCK_SQL, [before.rows[0]!.resource_key]);
    const result = await client.query<DbEvidence>(
      "SELECT evidence_id, resource_key, payload, status FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1 FOR UPDATE",
      [id],
    );
    const row = result.rows[0]!;
    if (row.status === "APPLIED") return mapEvidence(row);
    const pending = await client.query(
      `SELECT 1 FROM event_owner_stream_reservations WHERE resource_key = $1 AND status = 'OPEN'
       UNION ALL SELECT 1 FROM event_owner_stream_invalidations i JOIN event_owner_stream_reservations r
       ON r.reservation_id = ANY(i.affected_reservation_ids) WHERE r.resource_key = $1 AND i.status <> 'APPLIED' LIMIT 1`,
      [row.resource_key],
    );
    if (pending.rows.length) {
      await client.query("UPDATE event_owner_stream_inbound_evidence SET status = 'BLOCKED' WHERE evidence_id = $1", [
        id,
      ]);
      return { ...mapEvidence(row), status: "BLOCKED" };
    }
    await config.applyInboundEvidence(client, mapEvidence(row));
    await client.query("UPDATE event_owner_stream_inbound_evidence SET status = 'APPLIED' WHERE evidence_id = $1", [
      id,
    ]);
    return { ...mapEvidence(row), status: "APPLIED" };
  });
}
function mapReservation(row: DbReservation): OwnerStreamReservation {
  return {
    reservationId: row.reservation_id,
    operationId: row.operation_id,
    ownerStreamId: row.owner_stream_id,
    purpose: row.purpose,
    resourceKey: row.resource_key,
    consumer: { storeId: row.consumer_store_id, incarnation: row.consumer_incarnation, requestId: row.request_id },
    seal: { version: Number(row.seal_version), storeIncarnation: row.store_incarnation },
    target: row.target,
    commandFingerprint: row.command_fingerprint,
    status: row.status,
    ...(row.release_status ? { releaseStatus: row.release_status } : {}),
  };
}
function mapIntent(id: string, row: DbIntent): InvalidationIntent {
  return {
    ownerStreamId: id,
    generation: Number(row.generation),
    status: row.status,
    affectedReservationIds: row.affected_reservation_ids,
  };
}
function mapTerminal(row: DbTerminal): RequestTerminal {
  assertRequestTerminalBinding(row.binding);
  if (!["OPEN", "COMMITTED", "ABORTED"].includes(row.status)) conflict("Request terminal status is invalid.");
  return { ...row.binding, status: row.status };
}
function mapEvidence(row: DbEvidence): InboundEvidenceResult {
  return { evidenceId: row.evidence_id, resourceKey: row.resource_key, payload: row.payload, status: row.status };
}

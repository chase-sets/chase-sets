import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ConnectorPairingError } from "../domain/contracts";
import {
  assertConnectorLivenessAuthority,
  assertConnectorLivenessCandidates,
  assertConnectorLivenessRead,
  type ConnectorLivenessAuthority,
  type ConnectorLivenessCandidates,
  type ConnectorLivenessPage,
  type ConnectorLivenessRead,
} from "../domain/liveness";

type Row = {
  connection_id: string;
  status: string | null;
  authority_generation: string;
  live_pairing_id: string | null;
  heartbeat_revision: string;
  last_seen_at: Date | null;
  served_poll_window_seconds: number | null;
  served_policy_identity: string | null;
  heartbeat_due_at: Date | null;
};
const columns = `a.connection_id, c.status, a.authority_generation, a.live_pairing_id,
  a.heartbeat_revision, a.last_seen_at, a.served_poll_window_seconds, a.served_policy_identity, a.heartbeat_due_at`;

function decode(row: Row): ConnectorLivenessAuthority {
  if (row.status === null) throw new ConnectorPairingError("unavailable");
  const result = {
    connectionId: row.connection_id,
    connectionStatus: row.status,
    authorityGeneration: Number(row.authority_generation),
    livePairingId: row.live_pairing_id,
    heartbeatRevision: Number(row.heartbeat_revision),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    servedPollWindowSeconds: row.served_poll_window_seconds,
    servedPolicyIdentity: row.served_policy_identity,
    heartbeatDueAt: row.heartbeat_due_at?.toISOString() ?? null,
  };
  assertConnectorLivenessAuthority(result);
  return result;
}

export async function readConnectorLivenessAuthority(
  db: PgQueryable,
  input: ConnectorLivenessRead,
): Promise<ConnectorLivenessAuthority | null> {
  assertConnectorLivenessRead(input);
  const result = await db.query<Row>(
    `SELECT ${columns} FROM channel_connector_liveness_authority a
     LEFT JOIN channel_connections c ON c.connection_id=a.connection_id WHERE a.connection_id=$1`,
    [input.connectionId],
  );
  return result.rows[0] ? decode(result.rows[0]) : null;
}

// Caller owns the READ COMMITTED transaction. If it also takes the stream lock, take that first.
export async function readConnectorLivenessAuthorityInTransaction(
  db: PgQueryable,
  input: ConnectorLivenessRead,
): Promise<ConnectorLivenessAuthority | null> {
  assertConnectorLivenessRead(input);
  const exists = await db.query(
    "SELECT connection_id FROM channel_connector_liveness_authority WHERE connection_id=$1",
    [input.connectionId],
  );
  if (!exists.rows.length) return null;
  const connection = await db.query("SELECT connection_id FROM channel_connections WHERE connection_id=$1 FOR SHARE", [
    input.connectionId,
  ]);
  if (!connection.rows.length) throw new ConnectorPairingError("unavailable");
  const result = await db.query<Row>(
    `SELECT ${columns} FROM channel_connector_liveness_authority a
     LEFT JOIN channel_connections c ON c.connection_id=a.connection_id
     WHERE a.connection_id=$1 FOR SHARE OF a`,
    [input.connectionId],
  );
  return result.rows[0] ? decode(result.rows[0]) : null;
}

export async function listConnectorLivenessCandidates(
  db: PgQueryable,
  input: ConnectorLivenessCandidates,
): Promise<ConnectorLivenessPage> {
  assertConnectorLivenessCandidates(input);
  const result = await db.query<Row>(
    `SELECT ${columns} FROM channel_connector_liveness_authority a
     JOIN channel_connections c ON c.connection_id=a.connection_id
     WHERE c.status='active' AND a.live_pairing_id IS NOT NULL AND a.last_seen_at IS NOT NULL
       AND a.heartbeat_due_at <= $1::timestamptz
       AND ($2::timestamptz IS NULL OR (a.heartbeat_due_at,a.connection_id) > ($2::timestamptz,$3::text))
     ORDER BY a.heartbeat_due_at,a.connection_id LIMIT $4`,
    [input.dueAt, input.after?.heartbeatDueAt ?? null, input.after?.connectionId ?? null, input.limit + 1],
  );
  const candidates = result.rows.slice(0, input.limit).map(decode);
  const last = candidates.at(-1);
  return {
    candidates,
    nextCursor:
      result.rows.length > input.limit && last?.heartbeatDueAt
        ? { heartbeatDueAt: last.heartbeatDueAt, connectionId: last.connectionId }
        : null,
  };
}

export function createConnectorLivenessReader(db: PgQueryable) {
  return {
    readConnectorLivenessAuthority: (input: ConnectorLivenessRead) => readConnectorLivenessAuthority(db, input),
    readConnectorLivenessAuthorityInTransaction,
    listConnectorLivenessCandidates: (input: ConnectorLivenessCandidates) => listConnectorLivenessCandidates(db, input),
  };
}
export type ConnectorLivenessServices = ReturnType<typeof createConnectorLivenessReader>;

// Pairing-family callers already hold stream -> connection. Never call from claim admission.
export async function changeConnectorLivenessPairing(
  db: PgQueryable,
  connectionId: string,
  pairingId: string | null,
): Promise<void> {
  const inserted = await db.query(
    `INSERT INTO channel_connector_liveness_authority
      (connection_id,authority_generation,live_pairing_id,heartbeat_revision) VALUES ($1,1,$2,0)
     ON CONFLICT (connection_id) DO NOTHING RETURNING connection_id`,
    [connectionId, pairingId],
  );
  if (inserted.rows.length) return;
  const current = await db.query<{ authority_generation: string }>(
    "SELECT authority_generation FROM channel_connector_liveness_authority WHERE connection_id=$1 FOR UPDATE",
    [connectionId],
  );
  const generation = current.rows[0]?.authority_generation;
  if (generation === undefined) throw new ConnectorPairingError("conflict");
  const changed = await db.query(
    `UPDATE channel_connector_liveness_authority SET authority_generation=authority_generation+1,
      live_pairing_id=$2, last_seen_at=NULL, served_poll_window_seconds=NULL,
      served_policy_identity=NULL, heartbeat_due_at=NULL
     WHERE connection_id=$1 AND authority_generation=$3 RETURNING connection_id`,
    [connectionId, pairingId, generation],
  );
  if (changed.rows.length !== 1) throw new ConnectorPairingError("conflict");
}

export async function recordConnectorHeartbeat(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    pairingId: string;
    at: string;
    pollWindowSeconds: number;
    policyIdentity: string;
  }>,
): Promise<void> {
  const result = await db.query(
    `UPDATE channel_connector_liveness_authority SET heartbeat_revision=heartbeat_revision+1,
      last_seen_at=$3::timestamptz, served_poll_window_seconds=$4, served_policy_identity=$5,
      heartbeat_due_at=$3::timestamptz + $4 * interval '1 second'
     WHERE connection_id=$1 AND live_pairing_id=$2 AND (last_seen_at IS NULL OR last_seen_at < $3::timestamptz)
     RETURNING connection_id`,
    [input.connectionId, input.pairingId, input.at, input.pollWindowSeconds, input.policyIdentity],
  );
  if (result.rows.length) return;
  const current = await db.query<{ live_pairing_id: string | null }>(
    "SELECT live_pairing_id FROM channel_connector_liveness_authority WHERE connection_id=$1",
    [input.connectionId],
  );
  if (current.rows[0]?.live_pairing_id !== input.pairingId) throw new ConnectorPairingError("conflict");
}

import { hasProcessedProviderWebhookEvent, recordProviderWebhookEvent } from "@chase-sets/provider-webhook-inbox";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { assertClosedRecord, assertOpaqueId } from "../../connections/domain/validation";
import {
  ConnectorTransportError,
  connectorInboundKinds,
  type ConnectorInbound,
  type ConnectorInboundKind,
} from "../domain/transport";

export type AdmittedConnectorInboundEvent = Readonly<{
  providerEventId: string;
  connectionId: string;
  inboundKind: ConnectorInboundKind;
  externalReference: string;
  receivedAt: string;
  sequence: string;
  content: Readonly<{ state: "available"; payload: ConnectorInbound["payload"] }> | Readonly<{ state: "expired" }>;
}>;
export type ConnectorInboundRead = Readonly<{
  connectionId: string;
  inboundKind: ConnectorInboundKind;
  after?: string;
  limit?: number;
}>;
export type ConnectorInboundPage = Readonly<{
  events: readonly AdmittedConnectorInboundEvent[];
  nextCursor: string | null;
  horizon: string;
  completeness:
    | Readonly<{ kind: "complete"; total: number }>
    | Readonly<{ kind: "bounded-incomplete"; reason: "identity-count-mismatch" | "total-out-of-range" }>;
}>;
type Cursor = Readonly<{
  connectionId: string;
  inboundKind: ConnectorInboundKind;
  horizon: string;
  after: string;
  seen: number;
  total: number;
}>;
type Row = {
  provider_event_id: string;
  provider_object_reference: string;
  received_at: Date | string;
  admitted_sequence: string;
  payload: ConnectorInbound["payload"] | null;
};

export async function readAdmittedConnectorInboundEvents(
  pool: PgTransactionalPool,
  input: ConnectorInboundRead,
): Promise<ConnectorInboundPage> {
  return createConnectorInboundReader(pool)(input);
}

function lockKey(connectionId: string, inboundKind: ConnectorInboundKind) {
  return JSON.stringify(["channels.connector-inbound", connectionId, inboundKind]);
}
export async function admitConnectorInbound(
  db: PgQueryable,
  connectionId: string,
  input: ConnectorInbound,
  receivedAt: string,
): Promise<void> {
  // Sequence allocation happens only behind this transaction lock. A horizon cannot overtake a late commit.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(connectionId, input.inboundKind)]);
  const providerEventId = JSON.stringify([connectionId, input.inboundKind, input.externalReference]);
  if (await hasProcessedProviderWebhookEvent(db, { tableName: "channel_connector_inbound_events", providerEventId }))
    return;
  const inserted = await recordProviderWebhookEvent(db, {
    tableName: "channel_connector_inbound_events",
    providerEventId,
    providerName: "channel-connector",
    eventKind: input.inboundKind,
    providerObjectReference: input.externalReference,
    receivedAt,
  });
  if (!inserted) return;
  await db.query(
    `INSERT INTO channel_connector_inbound_payloads
    (provider_event_id, inbound_kind, received_at, payload) VALUES ($1,$2,$3,$4::jsonb)`,
    [providerEventId, input.inboundKind, receivedAt, JSON.stringify(input.payload)],
  );
}

export function createConnectorInboundReader(pool: PgTransactionalPool) {
  return async function readAdmittedConnectorInboundEvents(input: ConnectorInboundRead): Promise<ConnectorInboundPage> {
    assertClosedRecord(input, ["connectionId", "inboundKind", "after", "limit"], "inbound read");
    assertOpaqueId(input.connectionId, "connectionId");
    if (!connectorInboundKinds.includes(input.inboundKind)) invalid();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
    const cursor = input.after === undefined ? null : decodeCursor(input.after, input);
    return withPgTransaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [
        lockKey(input.connectionId, input.inboundKind),
      ]);
      const horizonResult = await db.query<{ horizon: string }>(
        `SELECT COALESCE(MAX(admitted_sequence),0)::text AS horizon
        FROM channel_connector_inbound_events WHERE connection_id=$1 AND event_kind=$2`,
        [input.connectionId, input.inboundKind],
      );
      const horizon = cursor?.horizon ?? horizonResult.rows[0]?.horizon ?? "0";
      const counts = await db.query<{ total: string; before: string }>(
        `SELECT COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE admitted_sequence <= $4::bigint)::text AS before
        FROM channel_connector_inbound_events WHERE connection_id=$1 AND event_kind=$2 AND admitted_sequence <= $3::bigint`,
        [input.connectionId, input.inboundKind, horizon, cursor?.after ?? "0"],
      );
      const total = Number(counts.rows[0]?.total);
      const before = Number(counts.rows[0]?.before);
      if (!Number.isSafeInteger(total) || total < 0) return incomplete(horizon, "total-out-of-range");
      if (!Number.isSafeInteger(before) || before !== (cursor?.seen ?? 0) || (cursor && total !== cursor.total))
        return incomplete(horizon, "identity-count-mismatch");
      const page = await db.query<Row>(
        `SELECT e.provider_event_id,e.provider_object_reference,e.received_at,
        e.admitted_sequence::text,p.payload FROM channel_connector_inbound_events e
        LEFT JOIN channel_connector_inbound_payloads p USING (provider_event_id)
        WHERE e.connection_id=$1 AND e.event_kind=$2 AND e.admitted_sequence > $3::bigint AND e.admitted_sequence <= $4::bigint
        ORDER BY e.admitted_sequence LIMIT $5`,
        [input.connectionId, input.inboundKind, cursor?.after ?? "0", horizon, limit + 1],
      );
      const rows = page.rows.slice(0, limit);
      const seen = before + rows.length;
      if (seen > total || (page.rows.length <= limit && seen !== total) || (page.rows.length > limit && seen >= total))
        return incomplete(horizon, "identity-count-mismatch");
      const last = rows.at(-1);
      const nextCursor =
        page.rows.length > limit && last
          ? encodeCursor({
              connectionId: input.connectionId,
              inboundKind: input.inboundKind,
              horizon,
              after: last.admitted_sequence,
              seen,
              total,
            })
          : null;
      return {
        horizon,
        nextCursor,
        completeness: { kind: "complete", total },
        events: rows.map((row) => ({
          providerEventId: row.provider_event_id,
          connectionId: input.connectionId,
          inboundKind: input.inboundKind,
          externalReference: row.provider_object_reference,
          receivedAt: new Date(row.received_at).toISOString(),
          sequence: row.admitted_sequence,
          content: row.payload === null ? { state: "expired" } : { state: "available", payload: row.payload },
        })),
      };
    });
  };
}
function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function decodeCursor(value: string, input: ConnectorInboundRead): Cursor {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  assertClosedRecord(cursor, ["connectionId", "inboundKind", "horizon", "after", "seen", "total"], "inbound cursor");
  if (cursor.connectionId !== input.connectionId || cursor.inboundKind !== input.inboundKind) invalid();
  const { horizon, after, seen, total } = cursor;
  sequence(horizon);
  sequence(after);
  if (
    BigInt(after) > BigInt(horizon) ||
    typeof seen !== "number" ||
    !Number.isSafeInteger(seen) ||
    seen < 0 ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < seen
  )
    invalid();
  return { connectionId: input.connectionId, inboundKind: input.inboundKind, horizon, after, seen, total };
}
function sequence(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    invalid();
}
function incomplete(horizon: string, reason: "identity-count-mismatch" | "total-out-of-range"): ConnectorInboundPage {
  return { events: [], nextCursor: null, horizon, completeness: { kind: "bounded-incomplete", reason } };
}
function invalid(): never {
  throw new ConnectorTransportError("invalid-input");
}

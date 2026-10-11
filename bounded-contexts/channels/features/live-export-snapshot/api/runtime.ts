import { createHash, randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import type { ConnectorPolicy } from "../../connector-feed/domain/policy";
import type { AdmittedConnectorInboundEvent } from "../../connector-feed/read-model/inbound";
import { persistTcgplayerExportSnapshot } from "../../tcgplayer-csv/api/runtime";
import {
  assertDerivedTcgplayerSnapshot,
  type DerivedTcgplayerSnapshot,
} from "../../tcgplayer-csv/domain/derived-snapshot";

type Dependencies = Readonly<{
  db: PgTransactionalPool;
  readAdmittedConnectorInboundEvents: ConnectorTransportServices["readAdmittedConnectorInboundEvents"];
  resolveConnectorPolicy: () => Promise<Pick<ConnectorPolicy, "maxIngestBytes" | "maxIngestRecords">>;
}>;
type IngestLimits = Readonly<{ maxRecords: number; maxBytes: number }>;
type PlannedEvent =
  | Readonly<{ kind: "expired" | "refused" }>
  | Readonly<{ kind: "snapshot"; snapshotId: string; payload: DerivedTcgplayerSnapshot }>;
export type TcgplayerLiveExportSnapshotServices = ReturnType<typeof createTcgplayerLiveExportSnapshotRuntime>;

/** A pure function of the admitted provider event, so replaying the event can only find its own snapshot. */
export function liveExportSnapshotId(providerEventId: string): string {
  return `cisn_${createHash("sha256").update(providerEventId, "utf8").digest("hex").slice(0, 40)}`;
}

export function createTcgplayerLiveExportSnapshotRuntime(deps: Dependencies) {
  async function consumeConnection(connectionId: string): Promise<number> {
    const connection = await deps.db.query(
      `SELECT 1 FROM channel_connections WHERE connection_id=$1 AND provider_key='tcgplayer'`,
      [connectionId],
    );
    if (connection.rows.length === 0) return 0;
    const progress = await deps.db.query<{ cursor: string | null }>(
      `SELECT cursor FROM channel_live_export_consumer WHERE connection_id=$1`,
      [connectionId],
    );
    const cursor = progress.rows[0]?.cursor ?? null;
    const checkpoint = readCheckpoint(cursor);
    const page = await deps.readAdmittedConnectorInboundEvents({
      connectionId,
      inboundKind: "export",
      limit: 100,
      ...(checkpoint.after === null ? {} : { after: checkpoint.after }),
    });
    // An incomplete page is not evidence of the admitted set: persist nothing and keep the cursor.
    if (page.completeness.kind !== "complete") return 0;
    if (checkpoint.after === null && page.horizon === checkpoint.completedHorizon) return 0;
    const policy = await deps.resolveConnectorPolicy();
    const limits = { maxRecords: policy.maxIngestRecords, maxBytes: policy.maxIngestBytes };
    const planned = page.events
      .filter((event) => BigInt(event.sequence) > BigInt(checkpoint.completedHorizon))
      .map((event) => planEvent(event, limits));
    const nextCursor = JSON.stringify({
      after: page.nextCursor,
      completedHorizon: page.nextCursor === null ? page.horizon : checkpoint.completedHorizon,
    });
    const owner = randomUUID();
    const claim = await deps.db.query<{ revision: string; cursor: string | null }>(
      `INSERT INTO channel_live_export_consumer (connection_id,owner,lease_until,revision)
      VALUES ($1,$2,clock_timestamp()+interval '2 minutes',1)
      ON CONFLICT (connection_id) DO UPDATE SET owner=$2,lease_until=clock_timestamp()+interval '2 minutes',
        revision=channel_live_export_consumer.revision+1
      WHERE (channel_live_export_consumer.lease_until IS NULL OR channel_live_export_consumer.lease_until<clock_timestamp())
        AND channel_live_export_consumer.cursor IS NOT DISTINCT FROM $3
      RETURNING revision::text,cursor`,
      [connectionId, owner, cursor],
    );
    const claimed = claim.rows[0];
    if (!claimed) return 0;
    const fenced = async <T>(run: (db: PgQueryable) => Promise<T>): Promise<T> =>
      withPgTransaction(deps.db, async (db) => {
        const lock = await db.query(
          `SELECT 1 FROM channel_live_export_consumer WHERE connection_id=$1 AND owner=$2
          AND revision=$3 AND lease_until>clock_timestamp() FOR UPDATE`,
          [connectionId, owner, claimed.revision],
        );
        if (lock.rows.length !== 1) throw new Error("live-export-snapshot-claim-lost");
        return run(db);
      });
    try {
      if (claimed.cursor !== cursor) return 0;
      let persisted = 0;
      for (const plan of planned) {
        if (plan.kind !== "snapshot") continue;
        const ingestedAt = new Date().toISOString();
        // The snapshot table under the owner's advisory lock decides idempotency; an existing id is inert.
        const snapshot = await fenced((db) =>
          persistTcgplayerExportSnapshot(db, {
            snapshotId: plan.snapshotId,
            connectionId,
            surface: "live",
            parsed: plan.payload.parsed,
            ingestedAt,
            // #9286 R9286-2: the connector-measured instant verbatim, never ingestion or any consumer clock.
            capturedAt: plan.payload.capturedAt,
            capturedAtSource: "connector-captured",
          }),
        );
        if (snapshot) persisted += 1;
      }
      await fenced((db) =>
        db.query(
          `UPDATE channel_live_export_consumer SET cursor=$4,last_scanned_at=clock_timestamp()
          WHERE connection_id=$1 AND owner=$2 AND revision=$3`,
          [connectionId, owner, claimed.revision, nextCursor],
        ),
      );
      return persisted;
    } finally {
      await deps.db.query(
        `UPDATE channel_live_export_consumer SET owner=NULL,lease_until=NULL
        WHERE connection_id=$1 AND owner=$2 AND revision=$3`,
        [connectionId, owner, claimed.revision],
      );
    }
  }
  return {
    consumeConnection,
    async consumeDueConnections() {
      const connections = await deps.db.query<{ connection_id: string }>(`SELECT connection.connection_id
        FROM channel_connections AS connection LEFT JOIN channel_live_export_consumer AS consumer USING (connection_id)
        WHERE connection.provider_key='tcgplayer'
          AND EXISTS (SELECT 1 FROM channel_connector_inbound_events AS event
            WHERE event.connection_id=connection.connection_id AND event.event_kind='export'
              AND event.admitted_sequence > COALESCE((consumer.cursor::jsonb->>'completedHorizon')::bigint,0))
        ORDER BY consumer.last_scanned_at NULLS FIRST,connection.connection_id LIMIT 20`);
      let count = 0;
      for (const row of connections.rows) count += await consumeConnection(row.connection_id);
      return count;
    },
  };
}

function readCheckpoint(cursor: string | null): Readonly<{ after: string | null; completedHorizon: string }> {
  if (cursor === null) return { after: null, completedHorizon: "0" };
  const value: unknown = JSON.parse(cursor);
  if (
    typeof value !== "object" ||
    value === null ||
    !("after" in value) ||
    !(value.after === null || typeof value.after === "string") ||
    !("completedHorizon" in value) ||
    typeof value.completedHorizon !== "string" ||
    !/^(0|[1-9]\d{0,18})$/.test(value.completedHorizon)
  )
    throw new Error("live-export-snapshot-checkpoint-invalid");
  return { after: value.after, completedHorizon: value.completedHorizon };
}

function planEvent(event: AdmittedConnectorInboundEvent, limits: IngestLimits): PlannedEvent {
  // An identity row without payload is not a snapshot; it must never relabel an older one.
  if (event.content.state === "expired") return { kind: "expired" };
  const payload: unknown = event.content.payload;
  try {
    assertDerivedTcgplayerSnapshot(payload, limits);
    return { kind: "snapshot", snapshotId: liveExportSnapshotId(event.providerEventId), payload };
  } catch {
    // tcgplayer-orders invalid-record precedent: a payload the effective policy refuses persists nothing and is passed.
    return { kind: "refused" };
  }
}

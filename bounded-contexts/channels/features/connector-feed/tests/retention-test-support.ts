import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";
import type { JsonObject } from "@chase-sets/primitives/json";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { executeRetentionSweepBatch } from "@chase-sets/platform-runtime/retention-sweep";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import type { ConnectorInbound } from "../domain/transport";
import { admitConnectorInbound } from "../read-model/inbound";
import { connectorInboundRetentionSweeps } from "../read-model/retention-policy";

export const [inventorySnapshotSweep, orderObservationSweep] = connectorInboundRetentionSweeps as [
  BcRetentionSweep,
  BcRetentionSweep,
];

export function orderInbound(
  externalReference: string,
  record: JsonObject = { order: externalReference, lines: [{ sku: "synthetic", quantity: 1 }] },
): ConnectorInbound {
  return { inboundKind: "order", externalReference, payload: { version: 1, records: [record] } };
}

export function exportInbound(externalReference: string): ConnectorInbound {
  const values: Record<string, string> = {
    "TCGplayer Id": "123",
    "Total Quantity": "2",
    "Add to Quantity": "0",
    "TCG Marketplace Price": "1.00",
    Condition: "Near Mint",
  };
  const csv =
    tcgplayerLiveExportHeader.join(",") + "\n" + tcgplayerLiveExportHeader.map((key) => values[key] ?? "").join(",");
  const parsed = parseTcgplayerFullExport({ surface: "live", csv }, { maxRecords: 1 });
  if (parsed.kind !== "parsed" || parsed.surface !== "live") throw new Error("invalid-fixture-export");
  return {
    inboundKind: "export",
    externalReference,
    payload: {
      parsed: { ...parsed, surface: "live" },
      fileSha256: "a".repeat(64),
      capturedAt: "2026-10-07T12:00:00.000Z",
    },
  };
}

export function providerEventId(
  connectionId: string,
  inbound: Pick<ConnectorInbound, "inboundKind" | "externalReference">,
) {
  return JSON.stringify([connectionId, inbound.inboundKind, inbound.externalReference]);
}

/** Admits through the production admission function in its own transaction. */
export async function admit(
  pool: PgTransactionalPool,
  connectionId: string,
  inbound: ConnectorInbound,
  receivedAt = new Date().toISOString(),
) {
  await withPgTransaction(pool, (db) => admitConnectorInbound(db, connectionId, inbound, receivedAt));
  return providerEventId(connectionId, inbound);
}

/**
 * Re-positions one admission's identity and payload instants relative to the
 * calling transaction's CURRENT_TIMESTAMP, so a sweep in the same transaction
 * evaluates against an exactly frozen clock.
 */
export async function ageAdmission(db: PgQueryable, id: string, secondsAgo: number) {
  for (const table of ["channel_connector_inbound_events", "channel_connector_inbound_payloads"]) {
    await db.query(
      `UPDATE ${table} SET received_at = CURRENT_TIMESTAMP - make_interval(secs => $2::double precision)
      WHERE provider_event_id = $1`,
      [id, secondsAgo],
    );
  }
}

/** Positions both admission instants at an absolute UTC instant. */
export async function placeAdmission(db: PgQueryable, id: string, receivedAt: string) {
  for (const table of ["channel_connector_inbound_events", "channel_connector_inbound_payloads"]) {
    await db.query(`UPDATE ${table} SET received_at = $2::timestamptz WHERE provider_event_id = $1`, [id, receivedAt]);
  }
}

/**
 * The database clock as an admission instant. The harness freezes host Date at its
 * own instant, so rows that must stay fresh are admitted on this clock instead.
 */
export async function databaseNow(db: PgQueryable): Promise<string> {
  const now = (await db.query<{ now: Date }>("SELECT CURRENT_TIMESTAMP AS now")).rows[0]?.now;
  if (!now) throw new Error("missing-database-clock");
  return new Date(now).toISOString();
}

/** Runs the sweep's bounded batches to exhaustion in `db`, returning each batch's deleted count. */
export async function drain(db: PgQueryable, sweep: BcRetentionSweep, maxBatches = 50) {
  const batches: number[] = [];
  for (let index = 0; index < maxBatches; index++) {
    const deleted = await executeRetentionSweepBatch(db, sweep);
    batches.push(deleted);
    if (deleted < sweep.batchLimit) break;
  }
  return batches;
}

export async function payloadIds(db: PgQueryable): Promise<string[]> {
  // Sorted in JS so assertions never depend on the database collation.
  return (
    await db.query<{ provider_event_id: string }>("SELECT provider_event_id FROM channel_connector_inbound_payloads")
  ).rows
    .map((row) => row.provider_event_id)
    .sort();
}

export async function identityRows(db: PgQueryable) {
  return (
    await db.query<{ row: string }>(
      "SELECT row_to_json(e)::text AS row FROM channel_connector_inbound_events e ORDER BY admitted_sequence",
    )
  ).rows.map((row) => row.row);
}

/** Runs `body` in one transaction that is always rolled back, with an explicit session time zone. */
export async function inRolledBackTransaction<T>(
  pool: PgTransactionalPool,
  timeZone: string,
  body: (db: PgQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('TimeZone', $1, true)", [timeZone]);
    return await body(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Replaces the single transaction-clock token with a frozen instant; refuses an ambiguous rewrite. */
export function frozenAt(sweep: BcRetentionSweep, instant: string): BcRetentionSweep {
  if (sweep.predicateSql.split("CURRENT_TIMESTAMP").length !== 2 || !/^[0-9TZ:.-]+$/.test(instant))
    throw new Error("ambiguous-frozen-clock");
  return { ...sweep, predicateSql: sweep.predicateSql.replace("CURRENT_TIMESTAMP", `'${instant}'::timestamptz`) };
}

/** Builds a named mutant and asserts the rewrite actually changed the predicate. */
export function mutant(sweep: BcRetentionSweep, from: string | RegExp, to: string): BcRetentionSweep {
  const predicateSql = sweep.predicateSql.replace(from, to);
  if (predicateSql === sweep.predicateSql) throw new Error("inert-mutant");
  return { ...sweep, predicateSql };
}

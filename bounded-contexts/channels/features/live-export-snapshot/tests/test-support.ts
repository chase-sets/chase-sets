import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestData,
} from "@chase-sets/bounded-context-runtime/test-support";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { admitConnectorInbound, createConnectorInboundReader } from "../../connector-feed/read-model/inbound";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import type { DerivedTcgplayerSnapshot } from "../../tcgplayer-csv/domain/derived-snapshot";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import { createTcgplayerLiveExportSnapshotRuntime } from "../api/runtime";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
export const describeDb = baseUrl ? describe : describe.skip;
export const connectionId = "synthetic-live-export-connection";

type Pools = Readonly<Record<"channels", PgTransactionalPool>>;

/** One disposable Channels database per suite; each test starts from a reset, booted schema and one TCGplayer connection. */
export function liveExportDatabase(name: string, options: Readonly<{ boot: boolean }> = { boot: true }) {
  const state: { pools?: Pools } = {};
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["channels"], name);
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    state.pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestData(state.pools!, async () => {
      if (!options.boot) return;
      await bootstrapContextDatabase(channelsModule, state.pools!.channels);
    });
    if (!options.boot) return;
    await seedConnection(state.pools!.channels, connectionId);
  });
  afterAll(async () => {
    if (state.pools) await closeMultiContextTestPools(state.pools);
  });
  return {
    get db(): PgTransactionalPool {
      return state.pools!.channels;
    },
  };
}

export async function seedConnection(db: PgQueryable, id: string, providerKey = "tcgplayer"): Promise<void> {
  await db.query(
    `INSERT INTO channel_connections
    (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
    VALUES ($1,'synthetic-account',$2,'sandbox','active',now(),now(),'[]',now(),1)`,
    [id, providerKey],
  );
}

export type SyntheticListing = Readonly<{ productId: string; quantity: string; price: string; condition: string }>;
const oneListing: readonly SyntheticListing[] = [
  { productId: "123", quantity: "2", price: "1.00", condition: "Near Mint" },
];

/** A connector-derived Live export exactly as #7994 admits it; the digest is over the synthetic CSV bytes. */
export function liveExport(
  capturedAt: string,
  listings: readonly SyntheticListing[] = oneListing,
): DerivedTcgplayerSnapshot {
  const lines = listings.map((listing) => {
    const values: Record<string, string> = {
      "TCGplayer Id": listing.productId,
      "Total Quantity": listing.quantity,
      "Add to Quantity": "0",
      "TCG Marketplace Price": listing.price,
      Condition: listing.condition,
    };
    return tcgplayerLiveExportHeader.map((column) => values[column] ?? "").join(",");
  });
  const csv = [tcgplayerLiveExportHeader.join(","), ...lines].join("\n");
  const parsed = parseTcgplayerFullExport({ surface: "live", csv }, { maxRecords: listings.length });
  if (parsed.kind !== "parsed" || parsed.surface !== "live") throw new Error("invalid-fixture-export");
  return {
    parsed: { ...parsed, surface: "live" },
    fileSha256: createHash("sha256").update(csv, "utf8").digest("hex"),
    capturedAt,
  };
}

/** Admits through the #7994 owner and returns the provider event id it allocated. */
export async function admitExport(
  db: PgTransactionalPool,
  externalReference: string,
  payload: DerivedTcgplayerSnapshot,
  connection = connectionId,
): Promise<string> {
  await withPgTransaction(db, (transaction) =>
    admitConnectorInbound(
      transaction,
      connection,
      { inboundKind: "export", externalReference, payload },
      new Date().toISOString(),
    ),
  );
  const admitted = await db.query<{ provider_event_id: string }>(
    `SELECT provider_event_id FROM channel_connector_inbound_events
    WHERE connection_id=$1 AND event_kind='export' AND provider_object_reference=$2`,
    [connection, externalReference],
  );
  if (admitted.rows.length !== 1) throw new Error("synthetic-export-not-admitted");
  return admitted.rows[0]!.provider_event_id;
}

/** Payload expiry as retention performs it: the identity row stays, the payload row goes. */
export async function expirePayload(db: PgQueryable, providerEventId: string): Promise<void> {
  await db.query(`DELETE FROM channel_connector_inbound_payloads WHERE provider_event_id=$1`, [providerEventId]);
}

export type LiveExportRuntimeDependencies = Parameters<typeof createTcgplayerLiveExportSnapshotRuntime>[0];
export function liveExportRuntime(
  db: PgTransactionalPool,
  overrides: Partial<LiveExportRuntimeDependencies> = {},
  create: typeof createTcgplayerLiveExportSnapshotRuntime = createTcgplayerLiveExportSnapshotRuntime,
) {
  return create({
    db,
    readAdmittedConnectorInboundEvents: createConnectorInboundReader(db),
    resolveConnectorPolicy: async () => connectorPolicyDefaults,
    ...overrides,
  });
}

export async function snapshotEffects(db: PgQueryable) {
  return (
    await db.query(`SELECT
      (SELECT jsonb_agg(row_to_json(t) ORDER BY t.snapshot_generation) FROM channel_inventory_snapshots t) AS snapshots,
      (SELECT jsonb_agg(row_to_json(t) ORDER BY t.snapshot_id,t.row_number) FROM channel_inventory_snapshot_rows t) AS rows,
      (SELECT jsonb_agg(row_to_json(t)) FROM channel_export_schema_pins t) AS pins`)
  ).rows[0];
}

export async function liveSnapshots(db: PgQueryable) {
  return (
    await db.query<{
      snapshot_id: string;
      snapshot_generation: string;
      surface: string;
      captured_at: Date;
      ingested_at: Date;
      captured_at_source: string;
    }>(
      `SELECT snapshot_id,snapshot_generation::text,surface,captured_at,ingested_at,captured_at_source
      FROM channel_inventory_snapshots WHERE connection_id=$1 ORDER BY snapshot_generation`,
      [connectionId],
    )
  ).rows;
}

export async function consumerProgress(db: PgQueryable, connection = connectionId) {
  return (
    await db.query<{ cursor: string | null; owner: string | null; lease_until: Date | null; revision: string }>(
      `SELECT cursor,owner,lease_until,revision::text FROM channel_live_export_consumer WHERE connection_id=$1`,
      [connection],
    )
  ).rows[0];
}

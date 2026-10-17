import { expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import { module as channelsModule } from "../../../index";
import { liveExportSnapshotSchemaSql } from "../read-model/schema";
import {
  admitExport,
  connectionId,
  describeDb,
  expirePayload,
  liveExport,
  liveExportDatabase,
  liveExportRuntime,
  seedConnection,
  snapshotEffects,
} from "./test-support";

const capturedAt = "2026-10-10T11:00:00.000Z";
const at = "2026-10-10T12:00:00.000Z";
const upgradeId = "20261010_channels_live_export_snapshot";
const consumerId = "20261010_channels_live_export_consumer";
const oldSources = (sql: string) =>
  sql.replaceAll("'operator-declared', 'ingest', 'connector-captured'", "'operator-declared', 'ingest'");

describeDb("live-export-snapshot-bootstrap", () => {
  const h = liveExportDatabase("live_export_bootstrap", { boot: false });

  it("upgrades old rows and catalog-named checks, matches fresh boot, and boots twice inertly", async () => {
    const shape = async () =>
      (
        await h.db.query(`SELECT relation.relname,pg_get_constraintdef(c.oid) AS definition,c.convalidated
      FROM pg_constraint c JOIN pg_class relation ON relation.oid=c.conrelid
      JOIN pg_attribute a ON a.attrelid=relation.oid AND a.attname='captured_at_source'
      WHERE relation.oid IN ('channel_inventory_snapshots'::regclass,'channel_inventory_snapshot_rows'::regclass)
        AND c.contype='c' AND c.conkey=ARRAY[a.attnum] ORDER BY relation.relname`)
      ).rows;
    await bootstrapContextDatabase(channelsModule, h.db);
    const freshShape = await shape();
    const consumerShape = (
      await h.db.query(
        "SELECT column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='channel_live_export_consumer' ORDER BY ordinal_position",
      )
    ).rows;
    await resetMultiContextTestSchemas({ channels: h.db });
    const previous = {
      ...channelsModule,
      schemaSql: oldSources(channelsModule.schemaSql.replace(liveExportSnapshotSchemaSql, "")),
      schemaMigrations: channelsModule
        .schemaMigrations!.filter((m) => ![upgradeId, consumerId].includes(m.migrationId))
        .map((m) => ({ ...m, statements: m.statements.map(oldSources) })),
    };
    await bootstrapContextDatabase(previous, h.db);
    await seedConnection(h.db, connectionId);
    const services = channelsModule.createServices(h.db, {
      channelSaleRecorder: async () => {
        throw new Error("unexpected-sale");
      },
    });
    for (const source of ["operator-declared", "ingest"] as const) {
      await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
        snapshotId: `synthetic-old-${source}`,
        connectionId,
        surface: "staged",
        csv: "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n123,2,0,1.00",
        limits: { maxRecords: 1 },
        ingestedAt: at,
        capturedAt,
        capturedAtSource: source,
      });
    }
    const before = await snapshotEffects(h.db);
    await h.db.query(
      "ALTER TABLE channel_inventory_snapshots RENAME CONSTRAINT channel_inventory_snapshots_captured_at_source_check TO synthetic_header_source",
    );
    await h.db.query(
      "ALTER TABLE channel_inventory_snapshot_rows RENAME CONSTRAINT channel_inventory_snapshot_rows_captured_at_source_check TO synthetic_row_source",
    );
    await bootstrapContextDatabase(channelsModule, h.db);
    expect(await shape()).toEqual(freshShape);
    expect(
      (
        await h.db.query(
          "SELECT column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='channel_live_export_consumer' ORDER BY ordinal_position",
        )
      ).rows,
    ).toEqual(consumerShape);
    expect(await snapshotEffects(h.db)).toEqual(before);
    const checks = async () =>
      (
        await h.db.query(`SELECT conname,pg_get_constraintdef(oid) AS definition,convalidated
      FROM pg_constraint WHERE conname IN ('synthetic_header_source','synthetic_row_source') ORDER BY conname`)
      ).rows;
    expect(await checks()).toEqual([
      expect.objectContaining({
        conname: "synthetic_header_source",
        convalidated: true,
        definition: expect.stringContaining("connector-captured"),
      }),
      expect.objectContaining({
        conname: "synthetic_row_source",
        convalidated: true,
        definition: expect.stringContaining("connector-captured"),
      }),
    ]);
    await admitExport(h.db, "after-upgrade", liveExport(capturedAt));
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(1);
    for (const table of ["channel_inventory_snapshots", "channel_inventory_snapshot_rows"]) {
      for (const source of ["operator-declared", "ingest", "connector-captured"]) {
        await h.db.query(`UPDATE ${table} SET captured_at_source=$1 WHERE surface='live'`, [source]);
      }
      await expect(
        h.db.query(`UPDATE ${table} SET captured_at_source='unknown' WHERE surface='live'`),
      ).rejects.toMatchObject({ code: "23514" });
    }
    const state = await snapshotEffects(h.db);
    const constraints = await checks();
    const ledger = await h.db.query("SELECT * FROM bounded_context_schema_migrations ORDER BY migration_id");
    await bootstrapContextDatabase(channelsModule, h.db);
    await bootstrapContextDatabase(channelsModule, h.db);
    expect(await snapshotEffects(h.db)).toEqual(state);
    expect(await checks()).toEqual(constraints);
    expect((await h.db.query("SELECT * FROM bounded_context_schema_migrations ORDER BY migration_id")).rows).toEqual(
      ledger.rows,
    );
    expect(ledger.rows.filter((row) => [upgradeId, consumerId].includes(String(row.migration_id)))).toHaveLength(2);
  });
});

describeDb("live-export-snapshot day-after", () => {
  const h = liveExportDatabase("live_export_day_after");
  const progress = async () =>
    (await h.db.query("SELECT *,xmin::text AS transaction FROM channel_live_export_consumer ORDER BY connection_id"))
      .rows;

  it("empty, completed, expired-only and cold-runtime ticks perform no row writes, including over 100 events", async () => {
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(0);
    expect(await progress()).toEqual([]);
    for (let i = 0; i < 101; i++) {
      const id = await admitExport(h.db, `paged-${i}`, liveExport(capturedAt));
      await expirePayload(h.db, id);
    }
    const runtime = liveExportRuntime(h.db);
    expect(await runtime.consumeDueConnections()).toBe(0);
    const first = await progress();
    expect(JSON.parse(String(first[0]!.cursor)).after).not.toBeNull();
    expect(await runtime.consumeDueConnections()).toBe(0);
    const completed = await progress();
    expect(JSON.parse(String(completed[0]!.cursor)).after).toBeNull();
    const before = await snapshotEffects(h.db);
    await runtime.consumeDueConnections();
    await liveExportRuntime(h.db).consumeConnection(connectionId);
    expect(await progress()).toEqual(completed);
    expect(await snapshotEffects(h.db)).toEqual(before);
    await admitExport(h.db, "new-day", liveExport(capturedAt));
    await liveExportRuntime(h.db).consumeDueConnections();
    expect(await liveExportRuntime(h.db).consumeDueConnections()).toBe(1);
    const dayAfter = await progress();
    const snapshots = await snapshotEffects(h.db);
    await liveExportRuntime(h.db).consumeDueConnections();
    await liveExportRuntime(h.db).consumeConnection(connectionId);
    expect(await progress()).toEqual(dayAfter);
    expect(await snapshotEffects(h.db)).toEqual(snapshots);
  });

  it("due selection is not starved by twenty idle connections", async () => {
    for (let i = 0; i < 21; i++) await seedConnection(h.db, `idle-${i}`);
    await admitExport(h.db, "only-pending", liveExport(capturedAt));
    expect(await liveExportRuntime(h.db).consumeDueConnections()).toBe(1);
    expect(await progress()).toHaveLength(1);
  });
});

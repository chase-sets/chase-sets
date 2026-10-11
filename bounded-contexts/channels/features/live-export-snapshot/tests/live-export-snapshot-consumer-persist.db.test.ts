import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createConnectorInboundReader } from "../../connector-feed/read-model/inbound";
import { liveExportSnapshotId } from "../api/runtime";
import { consumerMutant } from "./mutants";
import {
  admitExport,
  connectionId,
  consumerProgress,
  describeDb,
  liveExport,
  liveExportDatabase,
  liveExportRuntime,
  liveSnapshots,
  snapshotEffects,
} from "./test-support";

const listings = [
  { productId: "123", quantity: "2", price: "1.00", condition: "Near Mint" },
  { productId: "456", quantity: "0", price: "12.34", condition: "Lightly Played" },
];

describeDb("live-export-snapshot-consumer-persist", () => {
  const h = liveExportDatabase("live_export_snapshot_persist");

  it("persists one admitted export as exactly one Live snapshot with verbatim rows and its file digest identity chain", async () => {
    const payload = liveExport("2026-10-10T11:00:00.000Z", listings);
    const providerEventId = await admitExport(h.db, "export.v1:first", payload);

    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(1);

    const snapshotId = liveExportSnapshotId(providerEventId);
    expect(snapshotId).toBe(`cisn_${createHash("sha256").update(providerEventId, "utf8").digest("hex").slice(0, 40)}`);
    expect(await liveSnapshots(h.db)).toEqual([
      expect.objectContaining({
        snapshot_id: snapshotId,
        snapshot_generation: "1",
        surface: "live",
        captured_at: new Date(payload.capturedAt),
        captured_at_source: "connector-captured",
      }),
    ]);
    const header = await h.db.query(
      `SELECT parsed_row_count,completeness,provider_key FROM channel_inventory_snapshots WHERE snapshot_id=$1`,
      [snapshotId],
    );
    expect(header.rows).toEqual([{ parsed_row_count: 2, completeness: "unverified", provider_key: "tcgplayer" }]);
    const rows = await h.db.query(
      `SELECT external_key,condition_text,total_quantity,pending_quantity_delta,price_amount_text,
        price_amount_minor::int AS price_amount_minor,reference_columns,row_number
      FROM channel_inventory_snapshot_rows WHERE snapshot_id=$1 ORDER BY row_number`,
      [snapshotId],
    );
    expect(rows.rows).toEqual(
      payload.parsed.rows.map((row) => ({
        external_key: row.externalKey,
        condition_text: row.conditionText,
        total_quantity: row.totalQuantity,
        pending_quantity_delta: row.pendingQuantityDelta,
        price_amount_text: row.priceAmountText,
        price_amount_minor: row.priceAmountMinor,
        reference_columns: row.referenceColumns,
        row_number: row.rowNumber,
      })),
    );
    // 9287-N1: snapshotId -> providerEventId -> externalReference -> fileSha256, with no file-digest column.
    const chain = await h.db.query(
      `SELECT event.provider_object_reference,payload.payload->>'fileSha256' AS file_sha256
      FROM channel_connector_inbound_events AS event
      JOIN channel_connector_inbound_payloads AS payload USING (provider_event_id)
      WHERE event.provider_event_id=$1`,
      [providerEventId],
    );
    expect(chain.rows).toEqual([{ provider_object_reference: "export.v1:first", file_sha256: payload.fileSha256 }]);
    const digestColumns = await h.db.query(
      `SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('channel_inventory_snapshots','channel_inventory_snapshot_rows')
        AND (column_name LIKE '%sha%' OR column_name LIKE '%digest%')`,
    );
    expect(digestColumns.rows).toEqual([]);
  });

  it("replaying the same provider event id persists nothing and creates no generation", async () => {
    const payload = liveExport("2026-10-10T11:00:00.000Z");
    const first = await admitExport(h.db, "export.v1:first", payload);
    const runtime = liveExportRuntime(h.db);
    expect(await runtime.consumeConnection(connectionId)).toBe(1);
    const once = await snapshotEffects(h.db);

    // Re-admission of the same reference is deduplicated by #7994; the next tick and a cold runtime are inert.
    expect(await admitExport(h.db, "export.v1:first", payload)).toBe(first);
    expect(await runtime.consumeConnection(connectionId)).toBe(0);
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(0);
    expect(await snapshotEffects(h.db)).toEqual(once);

    // Crash after persistence but before cursor commit: the sole owner, not the checkpoint, deduplicates.
    await h.db.query("UPDATE channel_live_export_consumer SET cursor=NULL");
    expect(await runtime.consumeConnection(connectionId)).toBe(0);
    expect(await snapshotEffects(h.db)).toEqual(once);

    // A claimed page that still holds the persisted event reaches the owner, which finds the id and stays inert.
    await admitExport(h.db, "export.v1:second", liveExport("2026-10-10T12:00:00.000Z"));
    expect(await runtime.consumeConnection(connectionId)).toBe(1);
    expect((await liveSnapshots(h.db)).map((snapshot) => [snapshot.snapshot_id, snapshot.snapshot_generation])).toEqual(
      [
        [liveExportSnapshotId(first), "1"],
        [expect.stringMatching(/^cisn_[0-9a-f]{40}$/), "2"],
      ],
    );
  });

  it("duplicate control bypass mutant: an identity not derived from the provider event creates a second generation", async () => {
    await admitExport(h.db, "export.v1:first", liveExport("2026-10-10T11:00:00.000Z"));
    const mutant = consumerMutant(
      'createHash("sha256").update(providerEventId, "utf8").digest("hex").slice(0, 40)',
      'randomUUID().replaceAll("-", "")',
    );
    const runtime = liveExportRuntime(h.db, {}, mutant);
    expect(await runtime.consumeConnection(connectionId)).toBe(1);
    await h.db.query("UPDATE channel_live_export_consumer SET cursor=NULL");
    await runtime.consumeConnection(connectionId);
    const governing = async () => expect(await liveSnapshots(h.db)).toHaveLength(1);
    await expect(governing()).rejects.toThrow();
  });

  it("two overlapping ticks persist one snapshot and one generation", async () => {
    await admitExport(h.db, "export.v1:first", liveExport("2026-10-10T11:00:00.000Z"));
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    // Both ticks read the same complete page before either claims, so both pass the inert pre-check.
    const gated = () => {
      const read = createConnectorInboundReader(h.db);
      return liveExportRuntime(h.db, {
        readAdmittedConnectorInboundEvents: async (input) => {
          const page = await read(input);
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
          return page;
        },
      });
    };

    const results = await Promise.all([
      gated().consumeConnection(connectionId),
      gated().consumeConnection(connectionId),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect((await liveSnapshots(h.db)).map((snapshot) => snapshot.snapshot_generation)).toEqual(["1"]);
    expect(await consumerProgress(h.db)).toMatchObject({ owner: null, lease_until: null });
  });

  it("a tick whose lease was taken over cannot write; the new owner persists the single snapshot", async () => {
    await admitExport(h.db, "export.v1:first", liveExport("2026-10-10T11:00:00.000Z"));
    const takeover = interceptAfter(h.db, "SET owner=$2", async () => {
      await h.db.query(`UPDATE channel_live_export_consumer SET lease_until=clock_timestamp()-interval '1 second'`);
      expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(1);
    });

    await expect(liveExportRuntime(takeover).consumeConnection(connectionId)).rejects.toThrow(
      "live-export-snapshot-claim-lost",
    );

    expect((await liveSnapshots(h.db)).map((snapshot) => snapshot.snapshot_generation)).toEqual(["1"]);
    expect(await consumerProgress(h.db)).toMatchObject({ owner: null, revision: "2" });
  });
});

/** Runs `after` once, immediately after the first statement containing `marker` returns. */
function interceptAfter(db: PgTransactionalPool, marker: string, after: () => Promise<void>): PgTransactionalPool {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: Parameters<PgTransactionalPool["query"]>) => {
        const result = await target.query(...args);
        if (!fired && typeof args[0] === "string" && args[0].includes(marker)) {
          fired = true;
          await after();
        }
        return result;
      };
    },
  });
}

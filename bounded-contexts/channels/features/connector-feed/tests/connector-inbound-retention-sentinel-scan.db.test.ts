import { expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createRetentionSweepLogObserver,
  createRetentionSweepRunner,
  type RetentionSweepLogger,
} from "@chase-sets/platform-runtime/retention-sweep";
import { describeDb, target, transportDatabase } from "./transport-test-support";
import {
  ageAdmission,
  identityRows,
  inventorySnapshotSweep,
  orderInbound,
  orderObservationSweep,
  providerEventId,
  useDatabaseClock,
} from "./retention-test-support";

const SENTINEL = "SENTINEL-SHIP-TO-8592";
const SHIP_TO = `${SENTINEL} 742 Evergreen Terrace, Springfield 73301`;

describeDb("connector-inbound-retention-sentinel-scan", () => {
  const h = transportDatabase("connector_retention_sentinel_8592");

  async function tablesContainingSentinel(db: PgQueryable): Promise<string[]> {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const hits = [];
    for (const { table_name } of tables.rows) {
      const found = await db.query(
        `SELECT 1 FROM "${table_name.replaceAll('"', '""')}" AS t WHERE strpos(row_to_json(t)::text, $1) > 0 LIMIT 1`,
        [SENTINEL],
      );
      if (found.rows.length > 0) hits.push(table_name);
    }
    return hits;
  }

  it("keeps the ship-to out of identity, logs and retained observer events before and after deletion", async () => {
    await useDatabaseClock(h.db);
    const inbound = orderInbound("order.sentinel", { shipTo: SHIP_TO, lines: [{ sku: "synthetic", quantity: 1 }] });
    expect((await h.request("ingest", inbound)).status).toBe(202);
    const id = providerEventId(target.connectionId, inbound);

    // Positive control: the scan sees the sentinel where the payload legitimately lives.
    expect(await tablesContainingSentinel(h.db)).toEqual(["channel_connector_inbound_payloads"]);
    expect(JSON.stringify(await identityRows(h.db))).not.toContain(SENTINEL);

    const records: unknown[] = [];
    const logger: RetentionSweepLogger = {
      info: (message, fields) => records.push({ message, fields }),
      error: (message, fields) => records.push({ message, fields }),
    };
    // A real driver error whose message echoes the ship-to, raised on the first export batch.
    let failNext = true;
    const echoing: PgQueryable = {
      query: (async (sql: string, values?: unknown[]) => {
        if (failNext) {
          failNext = false;
          return h.db.query("SELECT $1::integer", [SHIP_TO]);
        }
        return h.db.query(sql, values);
      }) as PgQueryable["query"],
    };
    const runner = createRetentionSweepRunner({
      controlPlane: {
        claimScheduledRunner: vi.fn().mockResolvedValue(true),
        recordScheduledRunnerCompleted: vi.fn().mockResolvedValue(undefined),
      },
      targets: [
        { contextName: "channels", db: echoing, sweep: inventorySnapshotSweep },
        { contextName: "channels", db: h.db, sweep: orderObservationSweep },
      ],
      observer: createRetentionSweepLogObserver(logger),
    });

    await runner.runOnce();
    expect(await tablesContainingSentinel(h.db)).toEqual(["channel_connector_inbound_payloads"]);
    await ageAdmission(h.db, id, 7_776_000 + 3_600);
    await runner.runOnce();

    expect(await tablesContainingSentinel(h.db)).toEqual([]);
    expect(JSON.stringify(await identityRows(h.db))).toContain("order.sentinel");
    expect(records).toContainEqual({
      message: "Retention sweep failed; it will retry on its next interval.",
      fields: expect.objectContaining({ errorClass: "database-error", errorCode: "22P02" }),
    });
    expect(records).toContainEqual({
      message: "Retention sweep completed.",
      fields: expect.objectContaining({ sweepName: "connector-inbound-order-observation", deleted: 1 }),
    });
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    expect(JSON.stringify((await h.effects()).e3)).not.toContain(SENTINEL);
  });
});

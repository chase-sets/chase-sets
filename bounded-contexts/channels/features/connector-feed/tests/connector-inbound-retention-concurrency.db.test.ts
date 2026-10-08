import { expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createRetentionSweepLogObserver,
  createRetentionSweepRunner,
  executeRetentionSweepBatch,
} from "@chase-sets/platform-runtime/retention-sweep";
import { connectorPolicyDefaults } from "../domain/policy";
import type { ConnectorInboundKind } from "../domain/transport";
import { describeDb, target, transportDatabase } from "./transport-test-support";
import {
  admit,
  ageAdmission,
  drain,
  exportInbound,
  identityRows,
  inRolledBackTransaction,
  inventorySnapshotSweep,
  orderInbound,
  orderObservationSweep,
  payloadIds,
  databaseNow,
} from "./retention-test-support";

const HOUR = 3_600;
const EXPIRED_EXPORT_AGE = 604_800 + HOUR;

type PlanNode = Readonly<Record<string, unknown>> & { Plans?: PlanNode[] };
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describeDb("connector-inbound-retention-concurrency", () => {
  const h = transportDatabase("connector_retention_concurrency_8592");

  async function readWhole(inboundKind: ConnectorInboundKind) {
    const events = [];
    let after: string | undefined;
    for (;;) {
      const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      if (page.completeness.kind !== "complete") return { page, events };
      events.push(...page.events);
      if (!page.nextCursor) return { page, events };
      after = page.nextCursor;
    }
  }

  it("two sweepers racing ingest and paged reads delete only overdue payload and keep identities and whole reads", async () => {
    const expired = [];
    for (let index = 0; index < 6; index++) {
      const id = await admit(h.db, target.connectionId, exportInbound(`export.race-expired:${index}`));
      await ageAdmission(h.db, id, EXPIRED_EXPORT_AGE);
      expired.push(id);
    }
    const fresh = await admit(h.db, target.connectionId, exportInbound("export.race-fresh"));
    await ageAdmission(h.db, fresh, HOUR);

    const sweeper = async () => {
      const batches: number[] = [];
      for (let pass = 0; pass < 6; pass++) batches.push(...(await drain(h.db, inventorySnapshotSweep)));
      return batches;
    };
    // Concurrent admissions through the production admission function, on the database clock so they stay fresh.
    const admittedAt = await databaseNow(h.db);
    const ingests = async () => {
      const admitted = [];
      for (let index = 0; index < 3; index++)
        admitted.push(await admit(h.db, target.connectionId, exportInbound(`export.race-new:${index}`), admittedAt));
      return admitted;
    };
    const reads = async () => {
      const results = [];
      for (let pass = 0; pass < 3; pass++) results.push(await readWhole("export"));
      return results;
    };
    const [left, right, admitted, whole] = await Promise.all([sweeper(), sweeper(), ingests(), reads()]);

    expect([...left, ...right].every((deleted) => deleted <= inventorySnapshotSweep.batchLimit)).toBe(true);
    expect([...left, ...right].reduce((sum, deleted) => sum + deleted, 0)).toBe(6);
    for (const { page, events } of whole) {
      expect(page.completeness).toMatchObject({ kind: "complete" });
      expect(events).toHaveLength((page.completeness as { total: number }).total);
      expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
    }
    const final = await readWhole("export");
    expect(final.page.completeness).toEqual({ kind: "complete", total: 10 });
    const state = Object.fromEntries(final.events.map((event) => [event.externalReference, event.content.state]));
    for (let index = 0; index < 6; index++) expect(state[`export.race-expired:${index}`]).toBe("expired");
    for (const reference of ["export.race-fresh", "export.race-new:0", "export.race-new:1", "export.race-new:2"])
      expect(state[reference]).toBe("available");
    expect(await payloadIds(h.db)).toEqual([fresh, ...admitted].sort());
    expect(await identityRows(h.db)).toHaveLength(10);
  });

  it("rolls a sweep back safely, resumes after restart, and isolates one failed class until its next interval", async () => {
    const exportId = await admit(h.db, target.connectionId, exportInbound("export.restart"));
    const orderId = await admit(h.db, target.connectionId, orderInbound("order.restart"));
    await ageAdmission(h.db, exportId, EXPIRED_EXPORT_AGE);
    await ageAdmission(h.db, orderId, 7_776_000 + HOUR);

    await inRolledBackTransaction(h.db, "UTC", async (db) => {
      expect(await drain(db, inventorySnapshotSweep)).toEqual([1]);
      expect(await payloadIds(db)).toEqual([orderId]);
    });
    expect(await payloadIds(h.db)).toEqual([exportId, orderId].sort());

    h.restart();
    const records: { level: string; fields?: Readonly<Record<string, unknown>> }[] = [];
    const logger = {
      info: (_message: string, fields?: Readonly<Record<string, unknown>>) => records.push({ level: "info", fields }),
      error: (_message: string, fields?: Readonly<Record<string, unknown>>) => records.push({ level: "error", fields }),
    };
    let failNext = true;
    const flaky: PgQueryable = {
      query: (async (sql: string, values?: unknown[]) => {
        if (failNext) {
          failNext = false;
          // A real driver error: the DELETE never runs.
          return h.db.query("SELECT 'not-a-number'::integer");
        }
        return h.db.query(sql, values);
      }) as PgQueryable["query"],
    };
    const recordScheduledRunnerCompleted = vi.fn().mockResolvedValue(undefined);
    const runner = createRetentionSweepRunner({
      controlPlane: { claimScheduledRunner: vi.fn().mockResolvedValue(true), recordScheduledRunnerCompleted },
      targets: [
        { contextName: "channels", db: flaky, sweep: inventorySnapshotSweep },
        { contextName: "channels", db: h.db, sweep: orderObservationSweep },
      ],
      observer: createRetentionSweepLogObserver(logger),
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1 });
    expect(await payloadIds(h.db)).toEqual([exportId]);
    expect(records.find((record) => record.level === "error")?.fields).toMatchObject({
      sweepName: "connector-inbound-inventory-snapshot",
      errorClass: "database-error",
      errorCode: "22P02",
    });
    expect(recordScheduledRunnerCompleted).not.toHaveBeenCalledWith({
      runnerName: "retention.channels.connector-inbound-inventory-snapshot",
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1 });
    expect(await payloadIds(h.db)).toEqual([]);
    expect(recordScheduledRunnerCompleted).toHaveBeenCalledWith({
      runnerName: "retention.channels.connector-inbound-inventory-snapshot",
    });
    expect(await identityRows(h.db)).toHaveLength(2);
  });

  it("keeps batches at the historical-maximum bound after the policy is lowered; an unbounded batch mutant breaks it", async () => {
    // Historical rows admitted under the default policy are larger than anything the lowered policy admits.
    const blob = "x".repeat(2 * 1_048_576);
    for (let index = 0; index < 5; index++) {
      const id = await admit(h.db, target.connectionId, orderInbound(`order.historical:${index}`, { blob }));
      await ageAdmission(h.db, id, 7_776_000 + HOUR);
    }
    const freshExport = await admit(h.db, target.connectionId, exportInbound("export.multi-kind-fresh"));
    await ageAdmission(h.db, freshExport, HOUR);
    await h.connectorPolicy({ ...connectorPolicyDefaults, maxIngestBytes: 1_048_576 });
    const sizes = await h.db.query<{ bytes: string }>(
      "SELECT octet_length(payload::text)::text AS bytes FROM channel_connector_inbound_payloads WHERE inbound_kind='order'",
    );
    expect(sizes.rows.every((row) => Number(row.bytes) > 1_048_576)).toBe(true);

    const unbounded = { ...orderObservationSweep, batchLimit: Number.MAX_SAFE_INTEGER };
    const mutantBatches = await inRolledBackTransaction(h.db, "UTC", (db) => drain(db, unbounded));
    expect(mutantBatches).not.toEqual([2, 2, 1]);

    const plans = await inRolledBackTransaction(h.db, "UTC", async (db) => {
      await db.query("SET LOCAL enable_seqscan = off");
      const collected: string[] = [];
      const explain: PgQueryable = {
        query: (async (sql: string, values?: unknown[]) => {
          const result = await db.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, values);
          collected.push(JSON.stringify(result.rows[0]?.["QUERY PLAN"]));
          return { rows: [], rowCount: 0 };
        }) as PgQueryable["query"],
      };
      for (const sweep of [inventorySnapshotSweep, orderObservationSweep])
        await executeRetentionSweepBatch(explain, sweep);
      return collected;
    });
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      // LIMIT alone never bounds a scan: the candidate scan must be an index range on kind and deadline, unsorted.
      const limit = planNodes(JSON.parse(plan)[0].Plan).find((node) => node["Node Type"] === "Limit");
      const limited = limit ? planNodes(limit) : [];
      const scan = limited.find((node) => node["Index Name"] === "channel_connector_inbound_payload_retention_idx");
      expect(scan?.["Node Type"]).toBe("Index Scan");
      expect(String(scan?.["Index Cond"])).toMatch(/inbound_kind.*received_at/s);
      expect(limited.some((node) => node["Node Type"] === "Sort")).toBe(false);
    }

    expect(await drain(h.db, orderObservationSweep)).toEqual([2, 2, 1]);
    expect(orderObservationSweep.batchLimit * 134_217_728).toBeLessThanOrEqual(256 * 1_048_576);
    expect(await payloadIds(h.db)).toEqual([freshExport]);
    expect(await identityRows(h.db)).toHaveLength(6);
  });
});

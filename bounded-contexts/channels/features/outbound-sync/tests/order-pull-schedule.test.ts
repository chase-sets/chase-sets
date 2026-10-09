import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import {
  advanceScheduledBoundary,
  createOrderPullScanCursor,
  orderPullScheduleDue,
  scheduleDueOrderPulls,
  type OrderPullScanCursor,
} from "../api/order-pull";
import { OutboundSyncError, type OrderPullProducerDependencies } from "../domain/contracts";
import { syntheticAuthority } from "./order-pull-fixtures";

const startedAt = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(startedAt + offsetMs).toISOString();
const synthetic = (index: number) => `connection_synthetic_${String(index).padStart(3, "0")}`;

type SyntheticSchedule = { generation: number; nextDueAt: string; lastScheduledAt: string; revision: number };

/**
 * A synthetic SQL adapter for the scheduler's own statements. The due scan mirrors the real predicate
 * (keyset after `$5`, stored fence `$1`, cadence floor `$4`, no live pull, `LIMIT $3`); real PostgreSQL
 * locking and races are proven by `order-pull-producer.db.test.ts`.
 */
function syntheticProducer(connectionIds: readonly string[], options: Readonly<{ staleScan?: boolean }> = {}) {
  const schedules = new Map<string, SyntheticSchedule>();
  const live = new Set<string>();
  const held = new Set<string>();
  const minted: string[] = [];
  const scans: (readonly string[])[] = [];
  const holdReads: string[] = [];
  let authority: () => Promise<unknown> = async () => syntheticAuthority;
  let policy: () => Promise<unknown> = async () => ({ pollWindowSeconds: 60, leaseMs: 1_800_000 });
  let clock = startedAt;
  const result = (rows: readonly object[]) => ({ rows, rowCount: rows.length });
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    const id = params[0] as string;
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result([]);
    if (sql.includes("FROM channel_order_pull_chunks")) return result([]);
    if (sql.includes("FROM channel_connections AS connection")) {
      const [at, , limit, cadenceFloor, after] = params as [string, string, number, string, string | null];
      const rows = [...connectionIds]
        .sort()
        .filter((candidate) => after === null || candidate > after)
        .filter((candidate) => !live.has(candidate))
        .filter((candidate) => {
          const schedule = schedules.get(candidate);
          // A stale scan admits every scheduled connection, leaving only the locked re-check to fence it.
          if (options.staleScan) return true;
          return !schedule || (schedule.nextDueAt <= at && schedule.lastScheduledAt <= cadenceFloor);
        })
        .slice(0, limit);
      scans.push(rows);
      return result(rows.map((connection_id) => ({ connection_id })));
    }
    if (sql.includes("FROM channel_connections")) {
      return result([{ connection_id: id, provider_key: "tcgplayer", environment: "sandbox", status: "active" }]);
    }
    if (sql.includes("FROM channel_connector_pairings")) return result([{ pairing_id: `pairing_${id}` }]);
    if (sql.includes("FROM channel_order_pull_schedules")) {
      const schedule = schedules.get(id);
      return result(
        schedule
          ? [
              {
                generation: schedule.generation,
                next_due_at: schedule.nextDueAt,
                last_scheduled_at: schedule.lastScheduledAt,
                revision: schedule.revision,
              },
            ]
          : [],
      );
    }
    if (sql.includes("FROM channel_order_pull_operations")) return result(live.has(id) ? [{ operation_id: id }] : []);
    if (sql.includes("INSERT INTO channel_order_pull_schedules")) {
      if (schedules.has(id)) return result([]);
      const [, generation, nextDueAt, lastScheduledAt] = params as [string, number, string, string];
      schedules.set(id, { generation, nextDueAt, lastScheduledAt, revision: 1 });
      return result([{ connection_id: id }]);
    }
    if (sql.includes("UPDATE channel_order_pull_schedules")) {
      const [, generation, nextDueAt, lastScheduledAt, , revision] = params as [
        string,
        number,
        string,
        string,
        string,
        number,
      ];
      const schedule = schedules.get(id);
      if (!schedule || schedule.revision !== revision) return result([]);
      schedules.set(id, { generation, nextDueAt, lastScheduledAt, revision: revision + 1 });
      return result([{ connection_id: id }]);
    }
    if (sql.includes("INSERT INTO channel_order_pull_operations")) {
      const connectionId = params[1] as string;
      live.add(connectionId);
      minted.push(connectionId);
      return result([]);
    }
    throw new Error(`unexpected-synthetic-sql: ${sql.slice(0, 60)}`);
  });
  const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as PgTransactionalPool;
  const orderPull: OrderPullProducerDependencies = {
    resolveAuthority: () => authority(),
    resolveConnectorPolicy: () => policy() as ReturnType<OrderPullProducerDependencies["resolveConnectorPolicy"]>,
  };
  let scan: OrderPullScanCursor = createOrderPullScanCursor();
  const dependencies = {
    db,
    orderPull,
    readAdditionalOutboundHold: async ({ connectionId }: Readonly<{ connectionId: string }>) => {
      holdReads.push(connectionId);
      return held.has(connectionId)
        ? { held: true, sources: ["health" as const] }
        : { held: false, sources: [] as ("health" | "operator-kill")[] };
    },
  };
  return {
    schedules,
    live,
    held,
    minted,
    scans,
    holdReads,
    query,
    dependencies,
    tick: () =>
      scheduleDueOrderPulls(
        dependencies,
        { registry: channelProviderRegistry },
        () => new Date(clock).toISOString(),
        scan,
      ),
    at: (offsetMs: number) => {
      clock = startedAt + offsetMs;
    },
    restart: () => {
      scan = createOrderPullScanCursor();
    },
    pollWindow: (seconds: number) => {
      policy = async () => ({ pollWindowSeconds: seconds, leaseMs: 1_800_000 });
    },
    setAuthority: (resolve: () => Promise<unknown>) => {
      authority = resolve;
    },
    setPolicy: (resolve: () => Promise<unknown>) => {
      policy = resolve;
    },
    /** Settles the live pull the way a terminal report does; only the schedule then fences the next mint. */
    settle: (connectionId: string) => live.delete(connectionId),
  };
}

describe("order-pull schedule cadence: the persisted boundary under the effective poll window", () => {
  it("a 60 -> 300 s increase writes nothing before the new floor, then mints once on the allowed boundary", async () => {
    const producer = syntheticProducer([synthetic(0)]);
    expect(await producer.tick()).toBe(1);
    expect(producer.schedules.get(synthetic(0))).toMatchObject({ nextDueAt: iso(60_000), lastScheduledAt: iso(0) });
    producer.settle(synthetic(0));
    producer.pollWindow(300);
    const before = structuredClone([...producer.schedules]);
    for (const offset of [60_000, 120_000, 240_000, 299_999]) {
      producer.at(offset);
      expect(await producer.tick()).toBe(0);
      producer.restart();
      expect(await producer.tick()).toBe(0);
    }
    expect([...producer.schedules]).toEqual(before);
    expect(producer.minted).toEqual([synthetic(0)]);
    producer.at(300_000);
    expect(await producer.tick()).toBe(1);
    expect(producer.schedules.get(synthetic(0))).toMatchObject({
      generation: 2,
      lastScheduledAt: iso(300_000),
      nextDueAt: iso(600_000),
    });
  });

  it("the locked re-check refuses a candidate a stale scan admitted before the new floor", async () => {
    const producer = syntheticProducer([synthetic(0)], { staleScan: true });
    expect(await producer.tick()).toBe(1);
    producer.settle(synthetic(0));
    producer.pollWindow(300);
    for (const offset of [0, 60_000, 299_999]) {
      producer.at(offset);
      expect(await producer.tick()).toBe(0);
    }
    expect(producer.schedules.get(synthetic(0))).toMatchObject({ generation: 1, revision: 1 });
    producer.at(300_000);
    expect(await producer.tick()).toBe(1);
    expect(producer.minted).toEqual([synthetic(0), synthetic(0)]);
  });

  it("a decrease keeps the promised fence and a late tick mints one pull on the grid with no backlog", async () => {
    const producer = syntheticProducer([synthetic(0)]);
    producer.pollWindow(300);
    expect(await producer.tick()).toBe(1);
    producer.settle(synthetic(0));
    producer.pollWindow(60);
    producer.at(60_000);
    expect(await producer.tick()).toBe(0);
    producer.at(299_999);
    expect(await producer.tick()).toBe(0);
    producer.at(300_000);
    expect(await producer.tick()).toBe(1);
    expect(producer.schedules.get(synthetic(0))).toMatchObject({
      generation: 2,
      lastScheduledAt: iso(300_000),
      nextDueAt: iso(360_000),
    });
    producer.settle(synthetic(0));
    producer.at(545_000);
    expect(await producer.tick()).toBe(1);
    expect(producer.schedules.get(synthetic(0))).toMatchObject({
      generation: 3,
      lastScheduledAt: iso(540_000),
      nextDueAt: iso(600_000),
    });
    expect(await producer.tick()).toBe(0);
  });

  it("states the cadence law as pure boundary arithmetic", () => {
    const persisted = { nextDueAt: iso(60_000), lastScheduledAt: iso(0) };
    expect(orderPullScheduleDue(persisted, iso(60_000), 60_000)).toBe(true);
    expect(orderPullScheduleDue(persisted, iso(60_000), 300_000)).toBe(false);
    expect(orderPullScheduleDue(persisted, iso(299_999), 300_000)).toBe(false);
    expect(orderPullScheduleDue(persisted, iso(300_000), 300_000)).toBe(true);
    expect(orderPullScheduleDue({ nextDueAt: iso(300_000), lastScheduledAt: iso(0) }, iso(60_000), 60_000)).toBe(false);
    expect(advanceScheduledBoundary(iso(0), iso(300_000), 300_000)).toBe(iso(300_000));
    expect(advanceScheduledBoundary(iso(0), iso(245_000), 60_000)).toBe(iso(240_000));
  });
});

describe("order-pull schedule failures: inert absence versus a named scheduler error", () => {
  it("omitted producer and null authority stay inert with no policy or DB read", async () => {
    const producer = syntheticProducer([synthetic(0)]);
    const policy = vi.fn(async () => ({ pollWindowSeconds: 60, leaseMs: 1_800_000 }));
    producer.setPolicy(policy);
    producer.setAuthority(async () => null);
    expect(await producer.tick()).toBe(0);
    const { orderPull: _omitted, ...withoutProducer } = producer.dependencies;
    expect(
      await scheduleDueOrderPulls(
        withoutProducer,
        { registry: channelProviderRegistry },
        () => iso(0),
        createOrderPullScanCursor(),
      ),
    ).toBe(0);
    expect(policy).not.toHaveBeenCalled();
    expect(producer.query).not.toHaveBeenCalled();
  });

  it.each([
    [
      "authority outage",
      (producer: ReturnType<typeof syntheticProducer>) =>
        producer.setAuthority(async () => {
          throw new Error("synthetic-secret-authority-outage");
        }),
      "The order-pull authority could not be resolved.",
    ],
    [
      "policy outage",
      (producer: ReturnType<typeof syntheticProducer>) =>
        producer.setPolicy(async () => {
          throw new Error("synthetic-secret-policy-outage");
        }),
      "The connector transport policy could not be resolved.",
    ],
    [
      "policy decode failure",
      (producer: ReturnType<typeof syntheticProducer>) =>
        producer.setPolicy(async () => ({ pollWindowSeconds: 0, leaseMs: 1_800_000 })),
      "The connector transport policy could not be resolved.",
    ],
  ] as const)("a %s rejects with the safe named error and writes nothing", async (_case, inject, message) => {
    const producer = syntheticProducer([synthetic(0)]);
    inject(producer);
    const rejection = await producer.tick().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(OutboundSyncError);
    expect(rejection).toMatchObject({ name: "OutboundSyncError", code: "order-pull-schedule-unavailable", message });
    expect(JSON.stringify(rejection, Object.getOwnPropertyNames(rejection))).not.toContain("synthetic-secret");
    expect(producer.query).not.toHaveBeenCalled();
    expect(producer.minted).toEqual([]);
  });
});

describe("order-pull schedule scan continuation", () => {
  it("a held prefix of 100 cannot starve the eligible tail, and denied connections are never written", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => synthetic(index));
    const producer = syntheticProducer(ids);
    for (const id of ids.slice(0, 100)) producer.held.add(id);
    expect(await producer.tick()).toBe(0);
    expect(producer.scans[0]).toHaveLength(100);
    expect(producer.holdReads).toHaveLength(100);
    expect(await producer.tick()).toBe(1);
    expect(producer.minted).toEqual([synthetic(100)]);
    expect([...producer.schedules.keys()]).toEqual([synthetic(100)]);
    // The short page wrapped: the next lap re-examines the prefix and reaches a newly released earlier ID.
    producer.held.delete(synthetic(5));
    expect(await producer.tick()).toBe(1);
    expect(producer.scans[2]?.[0]).toBe(synthetic(0));
    expect(producer.minted).toEqual([synthetic(100), synthetic(5)]);
    expect(producer.scans.every((scan) => scan.length <= 100)).toBe(true);
  });

  it("an all-denied or empty scan laps with zero writes", async () => {
    const producer = syntheticProducer([synthetic(0), synthetic(1)]);
    producer.held.add(synthetic(0));
    producer.held.add(synthetic(1));
    expect(await Promise.all([producer.tick(), producer.tick(), producer.tick()])).toEqual([0, 0, 0]);
    expect(await producer.tick()).toBe(0);
    expect(producer.scans.map((scan) => scan[0])).toEqual(Array.from({ length: 4 }, () => synthetic(0)));
    expect(producer.minted).toEqual([]);
    expect(producer.schedules.size).toBe(0);
    const empty = syntheticProducer([]);
    expect(await empty.tick()).toBe(0);
    expect(await empty.tick()).toBe(0);
    expect(empty.minted).toEqual([]);
  });

  it("concurrent ticks over the held prefix still advance, and a failing candidate is passed", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => synthetic(index));
    const producer = syntheticProducer(ids);
    for (const id of ids.slice(0, 100)) producer.held.add(id);
    expect(await Promise.all([producer.tick(), producer.tick(), producer.tick()])).toEqual([0, 0, 0]);
    expect(await producer.tick()).toBe(1);
    expect(producer.minted).toEqual([synthetic(100)]);

    const failing = syntheticProducer([synthetic(0), synthetic(1)]);
    const read = failing.dependencies.readAdditionalOutboundHold;
    failing.dependencies.readAdditionalOutboundHold = async (input) => {
      if (input.connectionId === synthetic(0)) throw new Error("synthetic-hold-read-failure");
      return read(input);
    };
    await expect(failing.tick()).rejects.toThrow("synthetic-hold-read-failure");
    expect(await failing.tick()).toBe(1);
    expect(failing.minted).toEqual([synthetic(1)]);
  });

  it("drops an advance computed from a superseded position, so a late tick never moves the scan backwards", () => {
    const scan = createOrderPullScanCursor();
    const start = scan.current();
    scan.advance(start, synthetic(99));
    expect(scan.current()).toEqual({ lap: 0, step: 1, after: synthetic(99) });
    scan.advance(start, synthetic(40));
    expect(scan.current()).toEqual({ lap: 0, step: 1, after: synthetic(99) });
    const resumed = scan.current();
    scan.advance(resumed, null);
    expect(scan.current()).toEqual({ lap: 1, step: 0, after: null });
    scan.advance(resumed, synthetic(150));
    expect(scan.current()).toEqual({ lap: 1, step: 0, after: null });
  });
});

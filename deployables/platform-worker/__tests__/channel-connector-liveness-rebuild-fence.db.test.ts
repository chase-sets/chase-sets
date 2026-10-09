import { expect, it, vi } from "vitest";
import { loadProjectionGroupGeneration, rebuildContextProjectionGroup } from "@chase-sets/bounded-context-runtime";
import * as projectionRuntime from "@chase-sets/bounded-context-runtime";
import { createProjectionGroupWorkerRunner } from "@chase-sets/platform-runtime/worker";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  barrier,
  describeDb,
  livenessWorkerDatabase,
  target,
  transportContext,
} from "./channels-liveness-test-support";

describeDb("channel-connector-liveness-rebuild-fence", () => {
  const f = livenessWorkerDatabase("worker_liveness_rebuild_7934");
  const activeControl = "synthetic_active_rebuild_control";
  const projection = { targetContextName: "channels", projectionName: "channel-connection-projection" };

  async function prepare(status: "paused" | "disconnected") {
    await f.poll();
    expect((await f.sweep()).processed).toBe(1);
    await f.poll();
    const oldGeneration = await f.h.services.connectionHealth.listOpenReasonGenerations(target);
    expect(oldGeneration.find((reason) => reason.reasonCode === "connector-liveness")).toBeDefined();
    await f.h.connection(activeControl);
    await f.h.healthy(activeControl);
    const paired = await f.h.pair(activeControl);
    await f.poll(activeControl, paired.token);
    // Keep the actual 100-event projection batches: activation and the active control
    // must commit in an earlier replay batch than the parked terminal UPDATE.
    for (let index = 0; index < 50; index++) await f.h.connection(`synthetic_replay_padding_${index}`);
    vi.setSystemTime(new Date("2026-10-07T12:02:00.000Z"));
    if (status === "paused") await f.h.services.connections.pauseChannelConnection(target, transportContext);
    else await f.h.services.connections.disconnectChannelConnection(target, transportContext);
    await f.h.projectConnection();
    expect(await f.status(target.connectionId)).toBe(status);
    return oldGeneration;
  }

  function park(status: "paused" | "disconnected") {
    const entered = barrier();
    const release = barrier();
    let enabled = true;
    f.interceptQuery(async (sql, values) => {
      if (
        enabled &&
        sql.includes("UPDATE channel_connections") &&
        values[0] === target.connectionId &&
        (status === "paused" ? values[1] === "paused" : sql.includes("SET status = 'disconnected'"))
      ) {
        enabled = false;
        entered.release();
        await release.promise;
      }
    });
    return { entered, release };
  }

  async function assertParked() {
    expect(await loadProjectionGroupGeneration(f.h.db, projection)).toMatchObject({ state: "rebuilding" });
    expect(await f.status(target.connectionId)).toBe("active");
    expect(await f.status(activeControl)).toBe("active");
  }

  it.each([
    { status: "paused", readinessOmitted: false },
    { status: "disconnected", readinessOmitted: false },
    { status: "paused", readinessOmitted: true },
    { status: "disconnected", readinessOmitted: true },
  ] as const)(
    "rebuild-first $status refuses both open and close; readiness-omitted=$readinessOmitted discriminates the active control",
    async ({ status, readinessOmitted }) => {
      const oldGeneration = await prepare(status);
      const baseline = await f.livenessRows();
      const blocked = park(status);
      const rebuilding = rebuildContextProjectionGroup(f.runtime, "channels", projection.projectionName);
      try {
        await blocked.entered.promise;
        await assertParked();
        const sweep = vi.spyOn(f.h.services.connectionHealth, "sweepConnectorLiveness");
        expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
        expect((await sweep.mock.results[0]!.value).refusals).toContainEqual({
          connectionId: activeControl,
          reason: "connection-projection-rebuilding",
        });
        expect(await f.livenessRows()).toEqual(baseline);
        if (readinessOmitted) {
          const loadReadiness = projectionRuntime.loadProjectionGroupGeneration;
          const mutant = vi
            .spyOn(projectionRuntime, "loadProjectionGroupGeneration")
            .mockImplementation(async (...args) => {
              const generation = await loadReadiness(...args);
              return generation && { ...generation, state: "active" };
            });
          try {
            expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(1);
            const added = (await f.livenessRows()).filter(
              (row) => !baseline.some((prior) => JSON.stringify(prior) === JSON.stringify(row)),
            );
            expect(added).toHaveLength(1);
            expect(added[0]).toMatchObject({ observation: { connectionId: activeControl, outcome: "failure" } });
          } finally {
            mutant.mockRestore();
          }
        }
        expect(await f.h.services.connectionHealth.listOpenReasonGenerations(target)).toEqual(oldGeneration);
      } finally {
        blocked.release.release();
        await rebuilding;
      }
      expect(await f.status(target.connectionId)).toBe(status);
      expect(await loadProjectionGroupGeneration(f.h.db, projection)).toMatchObject({ state: "active" });
      if (!readinessOmitted) expect(await f.livenessRows()).toEqual(baseline);
      expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(readinessOmitted ? 0 : 1);
      expect(await f.h.services.connectionHealth.listOpenReasonGenerations(target)).toEqual(oldGeneration);
      const settled = await f.livenessRows();
      expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
      expect(await f.livenessRows()).toEqual(settled);
    },
  );

  it.each(["paused", "disconnected"] as const)(
    "sweep-first %s is inert on the settled row while active admission blocks reset until commit",
    async (status) => {
      await prepare(status);
      const locked = barrier();
      const release = barrier();
      const connect = f.h.db.connect.bind(f.h.db);
      let intercept = true;
      const connectSpy = vi.spyOn(f.h.db, "connect").mockImplementation(async () => {
        const client = await connect();
        const query: PgQueryable["query"] = async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(sql, values);
          if (
            intercept &&
            sql.includes("FROM channel_connections WHERE connection_id=$1 FOR SHARE") &&
            values?.[0] === activeControl
          ) {
            intercept = false;
            locked.release();
            await release.promise;
          }
          return result;
        };
        return { query, release: client.release.bind(client) };
      });
      const sweep = f.sweep("2026-10-07T12:02:00.000Z");
      let rebuilding: Promise<void> | undefined;
      const blocked = park(status);
      try {
        await locked.promise;
        rebuilding = rebuildContextProjectionGroup(f.runtime, "channels", projection.projectionName);
        await expect
          .poll(
            async () =>
              (
                await f.h.db.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%TRUNCATE%channel_connections%' AND pid<>pg_backend_pid()",
                )
              ).rows.length,
          )
          .toBeGreaterThan(0);
        release.release();
        expect((await sweep).processed).toBe(1);
        const afterAdmission = await f.livenessRows();
        await blocked.entered.promise;
        await assertParked();
        expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
        expect(await f.livenessRows()).toEqual(afterAdmission);
        blocked.release.release();
        await rebuilding;
        expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
        expect(await f.livenessRows()).toEqual(afterAdmission);
        expect(await f.status(target.connectionId)).toBe(status);
      } finally {
        release.release();
        blocked.release.release();
        await sweep;
        if (rebuilding) await rebuilding;
        connectSpy.mockRestore();
      }
    },
  );

  it.each(["paused", "disconnected"] as const)(
    "an aborted %s rebuild stays fenced until real group-runner replay settles",
    async (status) => {
      await prepare(status);
      const baseline = await f.livenessRows();
      const blocked = park(status);
      let aborted = false;
      const abort = new Error("synthetic-rebuild-aborted-at-barrier");
      const rebuilding = rebuildContextProjectionGroup(f.runtime, "channels", projection.projectionName, {
        throwIfLeaseLost: () => {
          if (aborted) throw abort;
        },
      });
      const completion = rebuilding.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await blocked.entered.promise;
        await assertParked();
        expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
        expect(await f.livenessRows()).toEqual(baseline);
        aborted = true;
      } finally {
        blocked.release.release();
      }
      expect(await completion).toBe(abort);
      expect(await loadProjectionGroupGeneration(f.h.db, projection)).toMatchObject({ state: "rebuilding" });
      expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
      expect(await f.livenessRows()).toEqual(baseline);
      const runner = createProjectionGroupWorkerRunner(f.group);
      for (let pass = 0; pass < 10; pass++) {
        await runner.runOnce();
        if ((await loadProjectionGroupGeneration(f.h.db, projection))?.state === "active") break;
        expect(await f.livenessRows()).toEqual(baseline);
        expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
      }
      expect(await loadProjectionGroupGeneration(f.h.db, projection)).toMatchObject({ state: "active" });
      expect(await f.status(target.connectionId)).toBe(status);
      expect(await f.livenessRows()).toEqual(baseline);
      // Only the canonically active control may open after readiness is restored.
      expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(1);
      const settled = await f.livenessRows();
      expect((await f.sweep("2026-10-07T12:02:00.000Z")).processed).toBe(0);
      expect(await f.livenessRows()).toEqual(settled);
    },
  );
});

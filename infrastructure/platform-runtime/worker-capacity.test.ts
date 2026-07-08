import { describe, expect, it } from "vitest";
import {
  assertRunnerCapacity,
  assertRunnerLaneIsolation,
  summarizeDatabasePoolPressure,
  summarizeRunnerCapacity,
} from "./worker-capacity";

describe("worker capacity", () => {
  it("summarizes configured runner concurrency against the database pool budget", () => {
    expect(
      summarizeRunnerCapacity(4, [
        { name: "projections", runnerCount: 10, maxConcurrentRunners: 2 },
        { name: "jobs", runnerCount: 2, maxConcurrentRunners: 1 },
      ]),
    ).toMatchObject({
      databasePoolMax: 4,
      configuredRunnerConcurrency: 3,
      reservedRunnerSlots: 0,
      overPoolCapacity: false,
      runnerGroups: {
        projections: {
          runnerCount: 10,
          maxConcurrentRunners: 2,
          reservedRunnerSlots: 0,
          reservedRunnerCount: 0,
          sharedRunnerCount: 10,
        },
      },
    });
  });

  it("fails fast when runner concurrency exceeds the database pool budget", () => {
    const capacity = summarizeRunnerCapacity(2, [
      { name: "projections", runnerCount: 10, maxConcurrentRunners: 2 },
      { name: "jobs", runnerCount: 2, maxConcurrentRunners: 1 },
    ]);

    expect(() => assertRunnerCapacity(capacity, { workerName: "Platform worker" })).toThrow(
      "Platform worker runner concurrency (3) exceeds DATABASE_POOL_MAX (2)",
    );
  });

  it("allows explicit local over-capacity override", () => {
    const capacity = summarizeRunnerCapacity(2, [
      { name: "projections", runnerCount: 10, maxConcurrentRunners: 2 },
      { name: "jobs", runnerCount: 2, maxConcurrentRunners: 1 },
    ]);

    expect(() =>
      assertRunnerCapacity(capacity, { workerName: "Platform worker", allowOverPoolCapacity: true }),
    ).not.toThrow();
  });

  it("counts the projection-operations group against the pool budget (#4620 regression)", () => {
    // The full platform-worker runner-group set. #4599 added the `operations`
    // group without raising the pool budget, so total concurrency (9) exceeded
    // DATABASE_POOL_MAX (7) and the guard crash-looped boot. The fix raises the
    // pool to cover every group.
    const groups = [
      { name: "projections", runnerCount: 1, maxConcurrentRunners: 1 },
      { name: "operations", runnerCount: 2, maxConcurrentRunners: 2 },
      { name: "jobs", runnerCount: 1, maxConcurrentRunners: 1 },
      { name: "inventory-jobs", runnerCount: 1, maxConcurrentRunners: 1 },
      { name: "dispatch", runnerCount: 1, maxConcurrentRunners: 1 },
      { name: "scheduled", runnerCount: 1, maxConcurrentRunners: 1 },
      { name: "wakes", runnerCount: 3, maxConcurrentRunners: 2 },
    ];

    // The pre-fix pool (7) is over capacity once operations is counted.
    const overCapacity = summarizeRunnerCapacity(7, groups);
    expect(overCapacity.configuredRunnerConcurrency).toBe(9);
    expect(overCapacity.overPoolCapacity).toBe(true);
    expect(() => assertRunnerCapacity(overCapacity, { workerName: "Platform worker" })).toThrow(
      "Platform worker runner concurrency (9) exceeds DATABASE_POOL_MAX (7)",
    );

    // Dropping operations to 1 and raising the pool to 8 fits exactly.
    const fitted = summarizeRunnerCapacity(8, [
      ...groups.slice(0, 1),
      { name: "operations", runnerCount: 1, maxConcurrentRunners: 1 },
      ...groups.slice(2),
    ]);
    expect(fitted.configuredRunnerConcurrency).toBe(8);
    expect(fitted.overPoolCapacity).toBe(false);
    expect(() => assertRunnerCapacity(fitted, { workerName: "Platform worker" })).not.toThrow();
  });

  it("summarizes reserved hot wake capacity separately from shared runner capacity", () => {
    expect(
      summarizeRunnerCapacity(6, [
        {
          name: "wakes",
          runnerCount: 3,
          maxConcurrentRunners: 2,
          reservedRunnerSlots: 1,
          reservedRunnerCount: 1,
          sharedRunnerCount: 2,
        },
        { name: "projections", runnerCount: 8, maxConcurrentRunners: 2 },
      ]),
    ).toMatchObject({
      configuredRunnerConcurrency: 4,
      reservedRunnerSlots: 1,
      runnerGroups: {
        wakes: {
          runnerCount: 3,
          maxConcurrentRunners: 2,
          reservedRunnerSlots: 1,
          reservedRunnerCount: 1,
          sharedRunnerCount: 2,
        },
      },
    });
  });

  it("accepts an isolated mixed wake lane with one hot reservation and one shared slot", () => {
    const capacity = summarizeRunnerCapacity(6, [
      {
        name: "wakes",
        runnerCount: 3,
        maxConcurrentRunners: 2,
        reservedRunnerSlots: 1,
        reservedRunnerCount: 1,
        sharedRunnerCount: 2,
      },
    ]);

    expect(() => assertRunnerLaneIsolation(capacity, { workerName: "Platform worker" })).not.toThrow();
  });

  it("fails when hot wake runners have no reserved slot", () => {
    const capacity = summarizeRunnerCapacity(6, [
      {
        name: "wakes",
        runnerCount: 3,
        maxConcurrentRunners: 2,
        reservedRunnerCount: 1,
        sharedRunnerCount: 2,
      },
    ]);

    expect(() => assertRunnerLaneIsolation(capacity, { workerName: "Platform worker" })).toThrow(
      "Platform worker runner group 'wakes' has 1 reserved-capacity runner(s) but reserves no slots.",
    );
  });

  it("fails when a reserved slot request has no reserved-capacity runner", () => {
    const capacity = summarizeRunnerCapacity(6, [
      {
        name: "wakes",
        runnerCount: 2,
        maxConcurrentRunners: 2,
        reservedRunnerSlots: 1,
        reservedRunnerCount: 0,
        sharedRunnerCount: 2,
      },
    ]);

    expect(() => assertRunnerLaneIsolation(capacity, { workerName: "Platform worker" })).toThrow(
      "Platform worker runner group 'wakes' reserves 1 slot(s) but has no reserved-capacity runners.",
    );
  });

  it("fails when mixed hot and shared lanes would clamp the reservation away", () => {
    const capacity = summarizeRunnerCapacity(6, [
      {
        name: "wakes",
        runnerCount: 3,
        maxConcurrentRunners: 1,
        reservedRunnerSlots: 1,
        reservedRunnerCount: 1,
        sharedRunnerCount: 2,
      },
    ]);

    expect(() => assertRunnerLaneIsolation(capacity, { workerName: "Platform worker" })).toThrow(
      "Platform worker runner group 'wakes' must allow 2 concurrent runner(s) to keep 1 reserved slot(s) isolated from shared work.",
    );
  });

  it("summarizes live database pool pressure with shared pool aliases deduped", () => {
    const sharedPool = {
      totalCount: 6,
      idleCount: 0,
      waitingCount: 2,
    };
    const settlementPool = {
      totalCount: 3,
      idleCount: 1,
      waitingCount: 0,
    };

    expect(
      summarizeDatabasePoolPressure(6, {
        control: sharedPool,
        checkout: sharedPool,
        settlement: settlementPool,
      }),
    ).toEqual({
      databasePoolMax: 6,
      poolCount: 2,
      totalClients: 9,
      idleClients: 1,
      activeClients: 8,
      waitingClients: 2,
      saturatedPoolCount: 1,
      waitingPoolCount: 1,
      pools: [
        {
          names: ["checkout", "control"],
          totalClients: 6,
          idleClients: 0,
          activeClients: 6,
          waitingClients: 2,
          saturated: true,
          waiting: true,
        },
        {
          names: ["settlement"],
          totalClients: 3,
          idleClients: 1,
          activeClients: 2,
          waitingClients: 0,
          saturated: false,
          waiting: false,
        },
      ],
    });
  });

  it("keeps pool pressure nullable when a test double does not expose node-postgres counters", () => {
    expect(
      summarizeDatabasePoolPressure(4, {
        control: { query: async () => ({ rows: [] }) },
      }),
    ).toEqual({
      databasePoolMax: 4,
      poolCount: 1,
      totalClients: null,
      idleClients: null,
      activeClients: null,
      waitingClients: null,
      saturatedPoolCount: null,
      waitingPoolCount: null,
      pools: [
        {
          names: ["control"],
          totalClients: null,
          idleClients: null,
          activeClients: null,
          waitingClients: null,
          saturated: null,
          waiting: null,
        },
      ],
    });
  });
});

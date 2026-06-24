import { describe, expect, it } from "vitest";
import { assertRunnerCapacity, assertRunnerLaneIsolation, summarizeRunnerCapacity } from "./worker-capacity";

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
});

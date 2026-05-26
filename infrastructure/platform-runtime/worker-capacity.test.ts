import { describe, expect, it } from "vitest";
import { assertRunnerCapacity, summarizeRunnerCapacity } from "./worker-capacity";

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
      overPoolCapacity: false,
      runnerGroups: {
        projections: {
          runnerCount: 10,
          maxConcurrentRunners: 2,
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
});

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerJobInput, WorkerJobRegistry } from "@chase-sets/platform-runtime/worker-jobs";
import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import type { PlatformWorkerConfig } from "../src/config";
import { workerContextRegistry } from "../src/context-registry";
import { createPlatformWorkerJobComposition } from "../src/worker-job-composition";
import baseline from "./fixtures/pre-registry-runner-census.json" with { type: "json" };
import { censusInput, censusRetention } from "./runner-census-test-support";

afterEach(() => vi.unstubAllEnvs());
type Input = WorkerJobInput<PlatformWorkerConfig>;
type Registry = WorkerJobRegistry<Input>;
const registry: Registry = workerContextRegistry;
async function census(input: ReturnType<typeof censusInput>, entries: Registry = registry) {
  const groups = createPlatformWorkerJobComposition(input, censusRetention, entries);
  const expectedIntervals = new Set(
    Object.values(baseline.profiles).flatMap((profile) =>
      profile.scheduled.filter((r) => r.intervalMs !== null).map((r) => r.name),
    ),
  );
  for (const runner of groups.scheduled) if (expectedIntervals.has(runner.name)) await runner.runOnce();
  const schedules = new Map(input.claims.map((claim) => [claim.runnerName, claim.intervalMs]));
  for (const entry of entries)
    for (const job of entry.manifest.scheduledJobs ?? []) {
      const observed = schedules.get(job.id);
      if (observed === undefined) continue;
      const configured = (key: string) =>
        key
          .split(".")
          .reduce<unknown>(
            (value, part) => (value && typeof value === "object" ? Reflect.get(value, part) : undefined),
            input.config,
          );
      expect(observed).toBe(
        job.schedule.kind === "interval" ? job.schedule.intervalMs : configured(job.schedule.configKey!),
      );
    }
  return Object.fromEntries(
    Object.entries(groups).map(([group, runners]) => [
      group,
      runners.map((runner) => ({
        name: runner.name,
        lease: runner.leaseName ?? `${runner.kind}:${runner.name}`,
        intervalMs: schedules.get(runner.name) ?? null,
      })),
    ]),
  );
}

describe("static worker job registry", () => {
  it("registry composes the same runner set as the hand-wired list", async () => {
    expect(baseline.head).toBe("7102e3d56ac12516cde7ee3ef8638c4afd38bfa5");
    for (const profile of ["landing", "proof", "public"] as const)
      for (const enabled of [false, true]) {
        const input = censusInput(profile, enabled);
        expect(await census(input)).toEqual(baseline.profiles[`${profile}:${enabled ? "enabled" : "disabled"}`]);
        expect(input.logger.info).toHaveBeenCalledExactlyOnceWith(
          "Worker registry jobs composed.",
          expect.objectContaining({ runtimeProfile: profile, type: "worker.registry-jobs" }),
        );
      }
  });
  it("detects removed, duplicate, schedule, lease, profile and missing-factory controls", async () => {
    const input = censusInput("proof");
    const change = (transform: (entry: Registry[number]) => Registry[number]) =>
      registry.map((entry) => (entry.contextName === "payments" ? transform(entry) : entry));
    const removed = change((entry) => ({
      ...entry,
      module: {
        ...entry.module,
        workerJobFactories: {
          ...entry.module.workerJobFactories,
          createPaymentsWalletFundingReconciliationRunners: () => [],
        },
      },
    }));
    expect(await census(censusInput("proof"), removed)).not.toEqual(baseline.profiles["proof:enabled"]);
    const duplicate = change((entry) => ({
      ...entry,
      manifest: {
        ...entry.manifest,
        scheduledJobs: [...entry.manifest.scheduledJobs!, entry.manifest.scheduledJobs![0]!],
      },
    }));
    expect(() => createPlatformWorkerJobComposition(input, censusRetention, duplicate)).toThrow(
      /payments.*duplicate job/,
    );
    const missing = change((entry) => ({ ...entry, module: { ...entry.module, workerJobFactories: {} } }));
    expect(() => createPlatformWorkerJobComposition(input, censusRetention, missing)).toThrow(
      /payments.*missing factory/,
    );
    const lease = change((entry) => ({
      ...entry,
      manifest: {
        ...entry.manifest,
        scheduledJobs: entry.manifest.scheduledJobs!.map((job) => ({ ...job, lockScope: "changed-lease" })),
      },
    }));
    expect(() => createPlatformWorkerJobComposition(input, censusRetention, lease)).toThrow(/payments.*lease/);
    const profile = change((entry) => ({
      ...entry,
      manifest: {
        ...entry.manifest,
        scheduledJobs: entry.manifest.scheduledJobs!.map((job) => ({ ...job, runtimeProfiles: ["public"] })),
      },
    }));
    expect(await census(censusInput("proof"), profile)).not.toEqual(baseline.profiles["proof:enabled"]);
    const schedule = censusInput("proof");
    Reflect.set(schedule.config, "paymentReconciliationIntervalMs", 87654);
    expect(await census(schedule)).not.toEqual(baseline.profiles["proof:enabled"]);
    const metadata = change((entry) => ({
      ...entry,
      manifest: {
        ...entry.manifest,
        scheduledJobs: entry.manifest.scheduledJobs!.map((job) => ({
          ...job,
          schedule: { kind: "interval", intervalMs: 3 },
        })),
      },
    }));
    await expect(census(censusInput("proof"), metadata)).rejects.toThrow();
  });
  it("admits a new job on an already registered module without a host edit", () => {
    const input = censusInput("proof");
    const runner: WorkerRunner = {
      name: "payments.synthetic-new-job",
      kind: "job",
      runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
    };
    const entries = registry.map((entry) =>
      entry.contextName !== "payments"
        ? entry
        : {
            ...entry,
            manifest: {
              ...entry.manifest,
              scheduledJobs: [
                ...entry.manifest.scheduledJobs!,
                {
                  id: runner.name,
                  runnerExport: "createSyntheticJob",
                  group: "scheduled",
                  order: 201,
                  runtimeProfiles: ["proof"],
                  schedule: { kind: "interval", intervalMs: 500 },
                  lockScope: `job:${runner.name}`,
                },
              ],
            },
            module: {
              ...entry.module,
              workerJobFactories: { ...entry.module.workerJobFactories, createSyntheticJob: () => [runner] },
            },
          },
    );
    expect(createPlatformWorkerJobComposition(input, censusRetention, entries).scheduled.at(-1)).toBe(runner);
  });
  it("keeps Catalog bulk on landing and source-only services eligible without activating other groups", () => {
    const input = censusInput("landing");
    const result = createPlatformWorkerJobComposition(input, censusRetention);
    expect(result.jobs).toHaveLength(6);
    expect(result.scheduled).toEqual([]);
    expect(result.dispatch).toEqual([]);
    expect(result["inventory-jobs"]).toEqual([]);
  });
  it("retains generic infrastructure call sites and uses the tested composition exactly once", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    for (const retained of baseline.retainedInfrastructure)
      expect(main.match(new RegExp(`(?<!import.*)\\b${retained.caller}\\(`, "g"))).toHaveLength(1);
    expect(main.match(/createPlatformWorkerJobComposition\(/g)).toHaveLength(1);
    expect(main).not.toMatch(
      /function create(?:CatalogBulk|Pricing|BulkRepriceIngestion|Settlement|NotificationDispatch).*Runners/,
    );
  });
});

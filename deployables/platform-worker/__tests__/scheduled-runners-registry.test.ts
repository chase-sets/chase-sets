import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerJobInput, WorkerJobRegistry } from "@chase-sets/platform-runtime/worker-jobs";
import { composeWorkerJobs } from "@chase-sets/platform-runtime/worker-jobs";
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
const recoveryRunner = {
  name: "pricing.evaluated-decision-recovery",
  lease: "job:pricing.evaluated-decision-recovery",
  intervalMs: 60_000,
};
type RunnerCensus = Record<
  keyof (typeof baseline.profiles)["proof:enabled"],
  { name: string; lease: string; intervalMs: number | null }[]
>;
function expectedCensus(profile: "landing" | "proof" | "public", enabled = true) {
  const expected: RunnerCensus = structuredClone(baseline.profiles[`${profile}:${enabled ? "enabled" : "disabled"}`]);
  if (profile !== "landing")
    expected.scheduled.unshift({
      name: "channels.ebay-account-deletion-consumer",
      lease: "job:channels.ebay-account-deletion-consumer",
      intervalMs: null,
    });
  if (profile !== "landing") {
    const afterRollups = expected.scheduled.findIndex(({ name }) => name === "pricing.market-rollups-closer") + 1;
    if (afterRollups) expected.scheduled.splice(afterRollups, 0, recoveryRunner);
    else {
      const next = expected.scheduled.findIndex(({ name }) => name === "fulfillment.postage-operation-reconciliation");
      expected.scheduled.splice(next, 0, recoveryRunner);
    }
  }
  return expected;
}
async function census(input: ReturnType<typeof censusInput>, entries: Registry = registry) {
  const groups = createPlatformWorkerJobComposition(input, censusRetention, entries);
  const expectedIntervals = new Set(
    Object.values(baseline.profiles)
      .flatMap((profile) => profile.scheduled.filter((r) => r.intervalMs !== null).map((r) => r.name))
      .concat(Object.values(baseline.alternateCapabilities).map((branch) => branch.runner.name)),
  );
  expectedIntervals.add(recoveryRunner.name);
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
  it("wires the Payments reconciler to the Ordering deadline runner and refuses to sweep without it", async () => {
    const input = censusInput("proof");
    vi.mocked(input.controlPlane.claimScheduledRunner).mockResolvedValue(true);
    const reconcileOrderPaymentBeforeDeadline = vi.fn();
    const sweepBreachedPaymentDeadlines = vi.fn(async () => ({ checked: 1, progressed: 1, cancelled: 0, failed: 0 }));
    const runnerFor = (payments: unknown) =>
      createPlatformWorkerJobComposition(
        {
          ...input,
          services: { ...input.services, ordering: { orders: { sweepBreachedPaymentDeadlines } }, payments },
        },
        censusRetention,
      ).scheduled.find((runner) => runner.name === "ordering.payment-deadline-sweep")!;

    await expect(runnerFor({ payments: { reconcileOrderPaymentBeforeDeadline } }).runOnce()).resolves.toMatchObject({
      processed: 1,
    });
    expect(sweepBreachedPaymentDeadlines).toHaveBeenCalledExactlyOnceWith(
      { limit: 100, reconcilePayment: reconcileOrderPaymentBeforeDeadline },
      expect.objectContaining({ tenantId: "tnt_identity" }),
    );
    await expect(runnerFor(undefined).runOnce()).rejects.toThrow("requires Payments reconciliation");
    expect(sweepBreachedPaymentDeadlines).toHaveBeenCalledTimes(1);
  });

  it("registry preserves the historical runner census plus the deletion consumer and Pricing recovery", async () => {
    expect(baseline.head).toBe("7102e3d56ac12516cde7ee3ef8638c4afd38bfa5");
    for (const profile of ["landing", "proof", "public"] as const)
      for (const enabled of [false, true]) {
        const input = censusInput(profile, enabled);
        expect(await census(input)).toEqual(expectedCensus(profile, enabled));
        expect(input.logger.info).toHaveBeenCalledExactlyOnceWith(
          "Worker registry jobs composed.",
          expect.objectContaining({ runtimeProfile: profile, type: "worker.registry-jobs" }),
        );
      }
  });
  it("does not schedule Pricing recovery without the evaluation authority port", async () => {
    for (const profile of ["proof", "public"] as const) {
      const input = censusInput(profile, true, false);
      const result = await census(input);
      expect(result.scheduled?.some(({ name }) => name === recoveryRunner.name)).toBe(false);
      expect(input.claims.some(({ runnerName }) => runnerName === recoveryRunner.name)).toBe(false);
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
    expect(await census(censusInput("proof"), removed)).not.toEqual(expectedCensus("proof"));
    const omittedDeletion = registry.map((entry) =>
      entry.contextName !== "channels"
        ? entry
        : {
            ...entry,
            module: {
              ...entry.module,
              workerJobFactories: {
                ...entry.module.workerJobFactories,
                createChannelsEbayAccountDeletionConsumerRunners: () => [],
              },
            },
          },
    );
    expect(await census(censusInput("proof"), omittedDeletion)).not.toEqual(expectedCensus("proof"));
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
    expect(await census(censusInput("proof"), profile)).not.toEqual(expectedCensus("proof"));
    const schedule = censusInput("proof");
    Reflect.set(schedule.config, "paymentReconciliationIntervalMs", 87654);
    expect(await census(schedule)).not.toEqual(expectedCensus("proof"));
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
  it("covers the original Fulfillment alternate capability across profiles, absence and omission", async () => {
    const captured = baseline.alternateCapabilities.fulfillmentPostagePurchaseFallback;
    const mainName = "fulfillment.postage-operation-reconciliation";
    expect(captured.head).toBe(baseline.head);
    expect(baseline.classification).toHaveProperty(captured.runner.name, "context-owned migration");
    const prepare = (profile: "landing" | "proof" | "public", enabled: boolean, available = true) => {
      const input = censusInput(profile, enabled);
      const calls: unknown[] = [];
      const reconcile = vi.fn(async (value: unknown) => {
        calls.push(["service", value]);
        return { checked: 3 };
      });
      const original = input.services.fulfillment;
      if (original) {
        const shipments = Reflect.get(original, "shipments");
        input.services.fulfillment = new Proxy(original, {
          get: (target, key) =>
            key !== "shipments"
              ? Reflect.get(target, key)
              : new Proxy(shipments, {
                  get: (target, key) =>
                    key === "listStalePostageOperationLocators" || key === "reconcilePostageOperationLocator"
                      ? undefined
                      : key === "reconcileStalePostageLabelPurchases"
                        ? available
                          ? reconcile
                          : undefined
                        : Reflect.get(target, key),
                }),
        });
      }
      return { input, calls, reconcile };
    };
    for (const profile of ["landing", "proof", "public"] as const) {
      for (const enabled of [false, true]) {
        const { input } = prepare(profile, enabled);
        const expected = expectedCensus(profile, enabled);
        expected.scheduled = expected.scheduled.map((runner) => (runner.name === mainName ? captured.runner : runner));
        expect(await census(input)).toEqual(expected);
        const absent = prepare(profile, enabled, false).input;
        expect((await census(absent)).scheduled).toEqual(
          expected.scheduled.filter((runner) => runner.name !== captured.runner.name),
        );
        if (profile !== "landing") {
          const removed = registry.map((entry) =>
            entry.contextName !== "fulfillment"
              ? entry
              : {
                  ...entry,
                  module: {
                    ...entry.module,
                    workerJobFactories: {
                      ...entry.module.workerJobFactories,
                      createFulfillmentPostageOperationReconciliationRunners: () => [],
                    },
                  },
                },
          );
          expect(await census(prepare(profile, enabled).input, removed)).not.toEqual(expected);
        }
      }
    }
    const { input, calls, reconcile } = prepare("proof", true);
    vi.spyOn(input.controlPlane, "claimScheduledRunner").mockImplementation(async (value) => {
      calls.push(["claim", value]);
      return true;
    });
    vi.spyOn(input.controlPlane, "recordScheduledRunnerCompleted").mockImplementation(async (value) => {
      calls.push(["complete", value]);
    });
    const runner = createPlatformWorkerJobComposition(input, censusRetention).scheduled.find(
      (runner) => runner.name === captured.runner.name,
    )!;
    expect(await runner.runOnce()).toEqual(captured.result);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(calls).toEqual(captured.calls);
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
  it("uses canonical explicit lease overrides and detects implicit/explicit lease collisions", () => {
    const input = censusInput("proof");
    const runner: WorkerRunner = {
      name: "payments.synthetic-override",
      kind: "job",
      leaseName: "job:shared",
      runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
    };
    const template = registry.find((entry) => entry.contextName === "payments")!;
    const entry = {
      ...template,
      manifest: {
        ...template.manifest,
        scheduledJobs: [
          {
            id: runner.name,
            runnerExport: "createSyntheticJob",
            group: "jobs",
            order: 1,
            runtimeProfiles: ["proof"],
            schedule: { kind: "dispatch" },
            lockScope: "job:shared",
          },
        ],
      },
      module: { ...template.module, workerJobFactories: { createSyntheticJob: () => [runner] } },
    };
    expect(composeWorkerJobs([entry], input, "proof").jobs).toEqual([runner]);
    const mismatch = {
      ...entry,
      manifest: {
        ...entry.manifest,
        scheduledJobs: entry.manifest.scheduledJobs.map((job) => ({ ...job, lockScope: "job:different" })),
      },
    };
    expect(() => composeWorkerJobs([mismatch], input, "proof")).toThrow(/lease differs/);
    const implicit = { ...runner, name: "shared", leaseName: undefined };
    expect(() =>
      composeWorkerJobs([entry], input, "proof", [{ order: 2, group: "jobs", create: () => [implicit] }]),
    ).toThrow(/duplicate runner lease job:shared/);
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

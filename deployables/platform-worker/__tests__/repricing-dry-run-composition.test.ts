import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPricingJobRunners } from "@chase-sets/pricing/server";
import { module as pricingModule } from "@chase-sets/pricing";
import type { RepricingEngineServices } from "@chase-sets/pricing/server";

describe("production repricing dry-run lane composition", () => {
  it("runs the main.ts lane callback without Marketplace and forwards cancellation and lease ownership", async () => {
    const text = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(pricingModule.workerJobFactories.createPricingJobRunners).toBe(createPricingJobRunners);
    const processNext: RepricingEngineServices["processNextDryRunJob"] = vi.fn(async (input) => {
      input.throwIfLeaseLost?.();
      return 1;
    });
    const runners = createPricingJobRunners({
      services: { pricing: { repricingEngine: { processNextDryRunJob: processNext } } },
      config: {
        workerId: "worker-7910",
        leaseTtlMs: 1_000,
        pricingRepricingDryRunJobLaneCount: 2,
        pricingRecommendationJobLaneCount: 1,
        pricingRecommendationJobWorkflowMaxActiveClaims: 1,
        pricingRecommendationJobMaxActiveClaimsPerJob: 1,
        pricingRepricingEvaluationJobLaneCount: 1,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(runners.map((runner) => runner.name)).toEqual([
      "job:pricing.repricing-dry-run-jobs.lane-1",
      "job:pricing.repricing-dry-run-jobs.lane-2",
    ]);
    const controller = new AbortController();
    const throwIfLeaseLost = vi.fn();
    expect(await runners[0]!.runOnce({ signal: controller.signal, throwIfLeaseLost })).toEqual({
      processed: 1,
      lastGlobalPosition: "0",
    });
    expect(processNext).toHaveBeenCalledWith({
      claimOwnerId: "worker-7910:job:pricing.repricing-dry-run-jobs.lane-1",
      claimTtlMs: 4_000,
      signal: controller.signal,
      throwIfLeaseLost,
    });
    expect(throwIfLeaseLost).toHaveBeenCalledOnce();
    expect(text).toContain("createPlatformWorkerJobComposition(");
    expect(text).not.toContain("function createPricingJobRunners");
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";
import type { RepricingEngineServices } from "@chase-sets/pricing/server";

describe("production repricing dry-run lane composition", () => {
  it("runs the main.ts lane callback without Marketplace and forwards cancellation and lease ownership", async () => {
    const text = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
    const declaration = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "createPricingJobRunners",
    );
    expect(declaration).toBeDefined();
    const compiled = ts.transpileModule(declaration!.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const processNext: RepricingEngineServices["processNextDryRunJob"] = vi.fn(async (input) => {
      input.throwIfLeaseLost?.();
      return 1;
    });
    const runners: readonly WorkerRunner[] = runInNewContext(compiled + "\ncreatePricingJobRunners(services, config)", {
      createDurableJobLaneRunners,
      services: { pricing: { repricingEngine: { processNextDryRunJob: processNext } } },
      config: { workerId: "worker-7910", leaseTtlMs: 1_000, pricingRepricingDryRunJobLaneCount: 2 },
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
    expect(text).toContain("...createPricingJobRunners(runtime.services, config)");
    expect(text).toContain('pricing?: Partial<Pick<PricingServices, "recommendations" | "repricingEngine">>');
  });
});

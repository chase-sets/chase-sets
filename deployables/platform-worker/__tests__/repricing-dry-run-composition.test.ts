import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";
import type {
  BulkRepriceIngestionServices,
  PricingServices,
  RepricingEngineServices,
} from "@chase-sets/pricing/server";
import { processRepricingEvaluationJob } from "../src/repricing-evaluation-lane";

describe("production repricing dry-run lane composition", () => {
  it("publishes every price-writer lane on behalf of the seller, preserving the system performer", async () => {
    const text = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
    const names = ["createPricingJobRunners", "createBulkRepriceIngestionJobRunners"];
    const declarations = names.map((name) =>
      source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name),
    );
    expect(declarations.every(Boolean)).toBe(true);
    const compiled = ts.transpileModule(declarations.map((node) => node!.getText(source)).join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const recommendation: PricingServices["recommendations"]["processNextRecommendationJob"] = async (input) => {
      await input
        .marketplaceListingGatewayForAccount("acc_recommendation")
        .applyBulkListingPriceUpdates({ updates: [], changeSource: "seller" });
      return 1;
    };
    const engine: RepricingEngineServices["processNextEvaluationJob"] = async (input) => {
      await input
        .marketplaceGatewayForAccount("acc_engine")
        .applyBulkListingPriceUpdates({ updates: [], changeSource: "repricing-engine" });
      return 1;
    };
    const bulk: BulkRepriceIngestionServices["processNextBulkRepriceJob"] = async (input) => {
      await input
        .marketplaceListingGatewayForAccount("acc_bulk")
        .applyBulkListingPriceUpdates({ updates: [], changeSource: "bulk-reprice" });
      return 1;
    };
    const applyPrices = vi.fn(async () => []);
    const runners: readonly WorkerRunner[] = runInNewContext(
      compiled +
        "\n[...createPricingJobRunners(services, config), ...createBulkRepriceIngestionJobRunners(services, config)]",
      {
        createDurableJobLaneRunners,
        processRepricingEvaluationJob,
        logger: { info: vi.fn() },
        SYSTEM_CONTEXT: {
          tenantId: "tnt_identity",
          audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
        },
        services: {
          pricing: {
            recommendations: { processNextRecommendationJob: recommendation },
            repricingEngine: { processNextEvaluationJob: engine },
            bulkRepriceIngestion: { processNextBulkRepriceJob: bulk },
          },
          marketplace: { listings: { applyBulkListingPriceUpdates: applyPrices } },
          inventory: { importBatches: { resolveAccountSkuMappingsToInventoryItems: vi.fn() } },
        },
        config: {
          workerId: "source-writers",
          leaseTtlMs: 1000,
          pricingRecommendationJobLaneCount: 1,
          pricingRepricingEvaluationJobLaneCount: 1,
          pricingBulkRepriceJobLaneCount: 1,
        },
      },
    );
    expect(runners).toHaveLength(3);
    for (const runner of runners) await runner.runOnce();
    expect(applyPrices).toHaveBeenCalledTimes(3);
    for (const [accountId, changeSource] of [
      ["acc_recommendation", "seller"],
      ["acc_engine", "repricing-engine"],
      ["acc_bulk", "bulk-reprice"],
    ]) {
      expect(applyPrices).toHaveBeenCalledWith(
        { accountId, updates: [], changeSource },
        {
          tenantId: "tnt_identity",
          audit: { performedByUserId: "usr_identity_system", forAccountId: accountId },
        },
      );
    }
  });

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

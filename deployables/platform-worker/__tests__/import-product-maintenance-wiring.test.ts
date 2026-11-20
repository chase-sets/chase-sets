import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { InventoryServices } from "@chase-sets/inventory/server";
import { module as inventoryModule } from "@chase-sets/inventory";
import { createInventoryJobRunners } from "@chase-sets/inventory/server";
import { createInventoryProductResolutionMaintenanceRunners } from "@chase-sets/inventory/server";

describe("Import Product maintenance worker composition", () => {
  it("forwards the live runner fence and signal to the imported Inventory service interface", async () => {
    const processNext = vi.fn<InventoryServices["importBatches"]["processNextImportProductResolutionMaintenanceJob"]>(
      async () => 1,
    );
    const signal = new AbortController().signal;
    const throwIfLeaseLost = vi.fn();
    const runners = createInventoryProductResolutionMaintenanceRunners(
      {
        inventory: {
          importBatches: {
            processNextImportProductResolutionMaintenanceJob: processNext,
          },
        },
      },
      { workerId: "worker-test", leaseTtlMs: 30_000 },
    );
    expect(runners.map((runner) => runner.name)).toEqual([
      "job:inventory.import-product-resolution-maintenance.lane-1",
    ]);
    expect(await runners[0]!.runOnce({ signal, throwIfLeaseLost })).toMatchObject({ processed: 1 });
    expect(processNext).toHaveBeenCalledWith({
      claimOwnerId: "worker-test:product-resolution-maintenance",
      claimTtlMs: 120_000,
      signal,
      throwIfLeaseLost,
    });
  });
  it("does not register a runner without its owning service", () => {
    expect(createInventoryProductResolutionMaintenanceRunners({}, { workerId: "test", leaseTtlMs: 1 })).toEqual([]);
  });
  it("main imports and invokes the tested factory, not a decoupled copy", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const inventoryJobRunners = readFileSync(
      new URL("../../../bounded-contexts/inventory/support/runtime-support/worker-jobs.ts", import.meta.url),
      "utf8",
    );
    expect(main).toContain("createPlatformWorkerJobComposition(");
    expect(inventoryModule.workerJobFactories.createInventoryJobRunners).toBe(createInventoryJobRunners);
    expect(inventoryJobRunners).toContain("createInventoryProductResolutionMaintenanceRunners(services, input)");
    expect(main).not.toContain('workflowName: "inventory.import-product-resolution-maintenance"');
    expect(inventoryJobRunners).toContain('workflowName: "inventory.import-product-resolution-maintenance"');
  });
});

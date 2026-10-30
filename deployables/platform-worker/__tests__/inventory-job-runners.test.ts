import { describe, expect, it, vi } from "vitest";
import { createInventoryJobRunners } from "../src/inventory-job-runners";

const config = {
  workerId: "worker_inventory_test",
  leaseTtlMs: 10_000,
  inventoryImportBatchJobLaneCount: 1,
  inventoryImportBatchJobWorkflowMaxActiveClaims: 1,
  inventoryImportBatchJobMaxActiveClaimsPerJob: 1,
} as const;

describe("inventory import draft delivery worker runner", () => {
  it("drains one delivery and emits one bounded terminal failure signal", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const processNextImportDraftListingDelivery = vi.fn(async () => ({
      outcome: "failed" as const,
      messageId: "imr_runner_1",
      attempts: 8,
      code: "inventory-draft-conflict:unexpected-failure",
    }));
    const [runner] = createInventoryJobRunners(
      { inventory: { importBatches: { processNextImportDraftListingDelivery } } },
      config,
      logger,
    );

    await expect(runner?.runOnce()).resolves.toMatchObject({ processed: 1 });
    expect(processNextImportDraftListingDelivery).toHaveBeenCalledExactlyOnceWith();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("Inventory draft listing delivery failed permanently.", {
      type: "inventory.import-draft-listing.delivery.failed",
      messageId: "imr_runner_1",
      attempts: 8,
      code: "inventory-draft-conflict:unexpected-failure",
    });
  });

  it("warns on a bounded transient requeue and stays silent on acceptance", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const results = [
      {
        outcome: "requeued" as const,
        messageId: "imr_runner_2",
        attempts: 1,
        code: "inventory-draft-unavailable:consumer-unbound",
      },
      { outcome: "accepted" as const, messageId: "imr_runner_3", attempts: 1 },
    ];
    const processNextImportDraftListingDelivery = vi.fn(async () => results.shift() ?? { outcome: "idle" as const });
    const [runner] = createInventoryJobRunners(
      { inventory: { importBatches: { processNextImportDraftListingDelivery } } },
      config,
      logger,
    );

    await runner?.runOnce();
    await runner?.runOnce();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Inventory draft listing delivery requeued.", {
      type: "inventory.import-draft-listing.delivery.requeued",
      messageId: "imr_runner_2",
      attempts: 1,
      code: "inventory-draft-unavailable:consumer-unbound",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

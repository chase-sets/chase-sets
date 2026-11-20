import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { BulkRepriceIngestionServices } from "./runtime";
import { applyBulkRepriceWaveUpdates, bulkRepriceRowDecision } from "./wave-outcomes";

// Exercise the coordinator with synthetic collaborator ports, not mocked SQL or persistence.
const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
const start = source.indexOf("  const processNextBulkRepriceJob:");
const end = source.indexOf("\n\n  return {\n    resolvePolicy,", start);
if (start < 0 || end <= start) throw new Error("Bulk reprice coordinator extraction failed.");
const body = stripTypeScriptTypes(source.slice(start, end));

function coordinator(laterWave: "reject" | "handoff" | "none", retainsClaim = true) {
  const rows = ["applied", "no_op", "error", "unknown", "later"].map((listingId, index) => ({
    rowNumber: index + 1,
    listingId,
  }));
  const total = laterWave === "none" ? 4 : 5;
  const claimed = {
    jobId: "job_synthetic_coordinator",
    payload: { accountId: "acc_synthetic", inputId: "input_synthetic", rowCount: total },
    eventContext: { synthetic: true },
    progress: { phase: "queued", completed: 0, total, message: "Queued" },
    result: null,
  };
  const jobStore = {
    claimNext: vi.fn(async () => claimed),
    fail: vi.fn(async () => true),
    updateProgress: vi.fn(async () => retainsClaim),
    complete: vi.fn(async () => true),
    get: vi.fn(async () => ({ status: "running" })),
  };
  const checkpoint = { checkpoint: vi.fn(async () => {}), flush: vi.fn(async () => {}) };
  const gateway = {
    applyBulkListingPriceUpdates: vi.fn(async () => ({
      items: ["applied", "no_op", "error", "unknown"].map((listingId) => ({
        listingId,
        outcome: listingId as "applied" | "no_op" | "error" | "unknown",
      })),
    })),
  };
  const handoff = new Error("Synthetic claim lost");
  let waves = 0;
  const ports = {
    jobStore,
    createDurableJobExecutionContext: () => ({ throwIfCancelled() {} }),
    createDurableJobProgressCheckpoint: () => checkpoint,
    resolvePolicy: async () => ({ chunkSize: 4, yieldIntervalMs: 0 }),
    loadInputRows: async () => rows.slice(0, total),
    chunkItems: (items: typeof rows) => [items.slice(0, 4), ...items.slice(4).map((row) => [row])],
    runDurableJobSideEffect: async (_context: unknown, work: () => Promise<number>) => work(),
    processBulkRepriceWave: async () => {
      if (waves++ > 0) {
        throw laterWave === "handoff" ? handoff : new Error("Synthetic next-wave transport failure");
      }
      const outcomes = await applyBulkRepriceWaveUpdates(gateway, {
        batchId: "bri_wave_synthetic",
        updates: rows.slice(0, 4).map(({ listingId }) => ({
          listingId,
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          idempotencyKey: `bri_row_${listingId}`,
        })),
      });
      return [...outcomes.values()].filter((outcome) => bulkRepriceRowDecision(outcome) === null).length;
    },
    deps: { db: null },
    bulkRepriceWaveBatchId: () => "bri_wave_synthetic",
    summarizeBulkRepriceRowOutcomes: async () => ({ applied: 1, unchanged: 1, failed: 1, total: 3 }),
    jobProgress: (phase: string, completed: number, total: number, message: string) => ({
      phase,
      completed,
      total,
      message,
    }),
    defaultLaneYield: async () => {},
    isDurableJobHandoffError: (error: unknown) => error === handoff,
    BULK_REPRICE_JOB_KIND: "bulk-reprice",
  };
  const run = new Function(...Object.keys(ports), `${body}\nreturn processNextBulkRepriceJob;`)(
    ...Object.values(ports),
  ) as BulkRepriceIngestionServices["processNextBulkRepriceJob"];
  return {
    run: () =>
      run({
        claimOwnerId: "worker_synthetic",
        claimTtlMs: 30_000,
        marketplaceListingGatewayForAccount: () => gateway,
        inventorySkuGatewayForAccount: () => ({ resolveSellerSkusToInventoryItems: async () => [] }),
      }),
    jobStore,
    checkpoint,
    gateway,
  };
}

describe("bulk reprice coordinator uncertainty", () => {
  it("retains unknown warnings and known terminal progress when a later wave rejects", async () => {
    const { run, jobStore, gateway } = coordinator("reject");
    expect(await run()).toBe(1);
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledTimes(2);
    const message = expect.stringMatching(
      /Synthetic next-wave transport failure.*1 .*remain unknown.*may already have applied/,
    );
    expect(jobStore.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: { phase: "failed", completed: 3, total: 5, message },
        errorMessage: message,
      }),
    );
    expect(jobStore.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ result: { applied: 1, unchanged: 1, failed: 1, total: 5 } }),
    );
    expect(jobStore.complete).not.toHaveBeenCalled();
  });

  it("preserves the single-wave exhaustion warning and terminal counts", async () => {
    const { run, jobStore, checkpoint } = coordinator("none");
    expect(await run()).toBe(1);
    expect(checkpoint.flush).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 3, total: 4, message: expect.stringContaining("may already have applied") }),
      { applied: 1, unchanged: 1, failed: 1, total: 4 },
    );
    expect(jobStore.fail).toHaveBeenCalledOnce();
  });

  it.each(["handoff", "lost failure checkpoint"])("does not fail a job after %s", async (mode) => {
    const { run, jobStore } = coordinator(mode === "handoff" ? "handoff" : "reject", mode === "handoff");
    expect(await run()).toBe(0);
    expect(jobStore.fail).not.toHaveBeenCalled();
    expect(jobStore.get).toHaveBeenCalledWith("job_synthetic_coordinator");
  });
});

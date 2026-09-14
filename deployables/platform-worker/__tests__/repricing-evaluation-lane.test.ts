import { readFileSync } from "node:fs";
import type { RepricingEngineServices } from "@chase-sets/pricing/server";
import { describe, expect, it, vi } from "vitest";
import { processRepricingEvaluationJob } from "../src/repricing-evaluation-lane";

describe("repricing evaluation lane", () => {
  it("logs exactly one structured ops signal per tripped product round, not per seller", async () => {
    const trip = {
      catalogItemId: "cat_1",
      productId: "cat_1::",
      direction: "down" as const,
      roundCount: 3,
      affectedSellerCount: 2,
      frozenUntil: "2026-07-17T14:00:00.000Z",
    };
    const logger = { info: vi.fn() };
    const processNext: RepricingEngineServices["processNextEvaluationJob"] = async (input) => {
      input.onSpiralBreakerTrip?.(trip);
      return 1;
    };
    const input = {
      claimOwnerId: "worker:repricing",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: vi.fn(),
    };
    await expect(processRepricingEvaluationJob(processNext, input, logger)).resolves.toBe(1);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("pricing.repricing-spiral-breaker.tripped", trip);
    await expect(processRepricingEvaluationJob(async () => 0, input, logger)).resolves.toBe(0);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(/processed:\s*await processRepricingEvaluationJob\(\s*processNextEvaluationJob,/.test(main)).toBe(true);
  });
});

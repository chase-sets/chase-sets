import { describe, expect, it } from "vitest";
import { createOpsDashboardRuntime } from "./ops-runtime";

describe("ops repricing source-share state", () => {
  it("keeps an absent host port unavailable instead of reporting zero activity", async () => {
    const runtime = createOpsDashboardRuntime({ db: {} as never });
    await expect(runtime.getRepricingSourceShare({ from: "2026-10-01", to: "2026-10-07" })).resolves.toEqual({
      status: "unavailable",
      weeks: [],
      reason: "port-unavailable",
    });
  });

  it("passes source-share state through the host port", async () => {
    const expected = {
      status: "available" as const,
      weeks: [
        {
          weekStart: "2026-10-04",
          status: "complete" as const,
          reason: null,
          eventCount: 0,
          counts: { bulk: 0, policy: 0, manual: 0, unattributed: 0 },
          shares: { bulk: 0, policy: 0, manual: 0 },
          topSellers: [],
        },
      ],
    };
    const runtime = createOpsDashboardRuntime({
      db: {} as never,
      crossContext: {
        getRepricingSourceShare: async () => expected,
        getPlatformGmvSeries: async () => [],
        getPlatformKpiSummary: async () => ({} as never),
        getPlatformLiquiditySummary: async () => ({} as never),
        getTopCatalogItemsByGmv: async () => [],
      },
    });
    await expect(runtime.getRepricingSourceShare({ from: "2026-10-01", to: "2026-10-07" })).resolves.toEqual(expected);
  });
});

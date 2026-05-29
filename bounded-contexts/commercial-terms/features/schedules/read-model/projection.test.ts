import { describe, expect, it } from "vitest";
import { buildScheduleProjectionHandlers } from "./projection";

describe("commercial terms schedule projection", () => {
  it("projects revised admin fee and allowance terms", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildScheduleProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["commercial-terms.schedule.revised"]?.({
      type: "commercial-terms.schedule.revised",
      data: {
        scheduleId: "cts_business",
        label: "Business revised",
        marketplaceSalesFeePercentageBps: 650,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 750,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      timing: { recordedAt: "2026-05-01T00:00:01.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("UPDATE commercial_terms_schedule_pages");
    expect(calls[0]?.params).toEqual([
      "cts_business",
      "Business revised",
      650,
      "0.00",
      750,
      "active",
      "2026-05-01T00:00:00.000Z",
      null,
      "2026-05-01T00:00:01.000Z",
    ]);
  });
});

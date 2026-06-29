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
      id: "evt_schedule_revised",
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
        revisedByUserId: "usr_admin",
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
    expect(calls[1]?.sql).toContain("INSERT INTO commercial_terms_schedule_history");
    expect(calls[1]?.params).toEqual([
      "cts_business",
      "evt_schedule_revised",
      "revised",
      "usr_admin",
      "active",
      JSON.stringify({
        label: "Business revised",
        marketplaceSalesFeePercentageBps: 650,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 750,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
      "2026-05-01T00:00:00.000Z",
      null,
      "2026-05-01T00:00:01.000Z",
    ]);
  });

  it("uses stored event audit actor when replaying pre-actor schedule events into history", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildScheduleProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["commercial-terms.schedule.revised"]?.({
      id: "evt_schedule_legacy",
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
      audit: { performedByUserId: "usr_replay", forAccountId: "acc_admin" },
      timing: { recordedAt: "2026-05-01T00:00:01.000Z" },
    } as never);

    expect(calls[1]?.params[1]).toBe("evt_schedule_legacy");
    expect(calls[1]?.params[3]).toBe("usr_replay");
  });
});

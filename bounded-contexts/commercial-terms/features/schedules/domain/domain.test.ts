import { describe, expect, it } from "vitest";
import {
  decideCommercialTermsSchedule,
  evolveCommercialTermsSchedule,
  initialCommercialTermsScheduleState,
} from "./domain";

describe("commercial terms schedules", () => {
  it("normalizes created schedules and rejects duplicate creation", () => {
    const [event] = decideCommercialTermsSchedule(initialCommercialTermsScheduleState, {
      type: "CreateSchedule",
      scheduleId: " default-personal ",
      label: " Default Personal ",
      accountType: "personal",
      marketplaceSalesFeePercentageBps: 250,
      marketplaceSalesFeeFixedAmount: "0",
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
    });
    const state = evolveCommercialTermsSchedule(initialCommercialTermsScheduleState, event!);

    expect(state).toMatchObject({
      scheduleId: "default-personal",
      label: "Default Personal",
      marketplaceSalesFeeFixedAmount: "0.00",
    });
    expect(() =>
      decideCommercialTermsSchedule(state, {
        type: "CreateSchedule",
        scheduleId: "default-personal",
        label: "Default Personal",
        accountType: "personal",
        marketplaceSalesFeePercentageBps: 250,
        marketplaceSalesFeeFixedAmount: "0",
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
      }),
    ).toThrow("Schedule has already been created.");
  });

  it("revises fees, allowances, status, and effective window", () => {
    const [created] = decideCommercialTermsSchedule(initialCommercialTermsScheduleState, {
      type: "CreateSchedule",
      scheduleId: "cts_business",
      label: "Business",
      accountType: "business",
      marketplaceSalesFeePercentageBps: 850,
      marketplaceSalesFeeFixedAmount: "0.10",
      shippingAllowancePercentageBps: 500,
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
    });
    const createdState = evolveCommercialTermsSchedule(initialCommercialTermsScheduleState, created!);

    const [revised] = decideCommercialTermsSchedule(createdState, {
      type: "ReviseSchedule",
      label: "Business revised",
      marketplaceSalesFeePercentageBps: 650,
      marketplaceSalesFeeFixedAmount: "0",
      shippingAllowancePercentageBps: 750,
      status: "inactive",
      effectiveFrom: "2026-05-01T00:00:00.000Z",
      effectiveUntil: "2026-06-01T00:00:00.000Z",
    });

    expect(revised).toMatchObject({
      type: "commercial-terms.schedule.revised",
      data: {
        scheduleId: "cts_business",
        label: "Business revised",
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 750,
      },
    });
    expect(evolveCommercialTermsSchedule(createdState, revised!)).toMatchObject({
      scheduleId: "cts_business",
      accountType: "business",
      label: "Business revised",
      status: "inactive",
      effectiveUntil: "2026-06-01T00:00:00.000Z",
    });
  });

  it("rejects impossible schedule percentages and effective windows", () => {
    expect(() =>
      decideCommercialTermsSchedule(initialCommercialTermsScheduleState, {
        type: "CreateSchedule",
        scheduleId: "cts_bad",
        label: "Bad",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 10_001,
        marketplaceSalesFeeFixedAmount: "0",
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
      }),
    ).toThrow("cannot exceed 10000 basis points");

    expect(() =>
      decideCommercialTermsSchedule(initialCommercialTermsScheduleState, {
        type: "CreateSchedule",
        scheduleId: "cts_bad",
        label: "Bad",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 250,
        marketplaceSalesFeeFixedAmount: "0",
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Schedule effective until must be after Schedule effective from.");
  });
});

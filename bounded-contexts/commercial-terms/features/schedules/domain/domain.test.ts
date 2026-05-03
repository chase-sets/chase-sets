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
      marketplaceFeePercentageBps: 250,
      marketplaceFeeFixedAmount: "0",
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
    });
    const state = evolveCommercialTermsSchedule(initialCommercialTermsScheduleState, event!);

    expect(state).toMatchObject({
      scheduleId: "default-personal",
      label: "Default Personal",
      marketplaceFeeFixedAmount: "0.00",
    });
    expect(() =>
      decideCommercialTermsSchedule(state, {
        type: "CreateSchedule",
        scheduleId: "default-personal",
        label: "Default Personal",
        accountType: "personal",
        marketplaceFeePercentageBps: 250,
        marketplaceFeeFixedAmount: "0",
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
      }),
    ).toThrow("Schedule has already been created.");
  });
});

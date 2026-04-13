import { describe, expect, it } from "vitest";
import {
  decidePayout,
  evolvePayout,
  initialPayoutState,
} from "./domain";

describe("settlement payout domain", () => {
  it("schedules, sends, and completes a payout", () => {
    const scheduledState = decidePayout(initialPayoutState, {
      type: "SchedulePayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      amount: "25.00",
      currencyCode: "usd",
      destinationReference: "bank_123",
      note: "Weekly payout",
      scheduledAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolvePayout, initialPayoutState);

    const sentState = decidePayout(scheduledState, {
      type: "MarkPayoutInTransit",
      sentAt: "2026-04-02T01:00:00.000Z",
    }).reduce(evolvePayout, scheduledState);

    const completedState = decidePayout(sentState, {
      type: "CompletePayout",
      completedAt: "2026-04-02T02:00:00.000Z",
    }).reduce(evolvePayout, sentState);

    expect(completedState.status).toBe("completed");
    expect(completedState.sentAt).toBe("2026-04-02T01:00:00.000Z");
    expect(completedState.completedAt).toBe("2026-04-02T02:00:00.000Z");
  });

  it("fails idempotently", () => {
    const scheduledState = decidePayout(initialPayoutState, {
      type: "SchedulePayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      amount: "25.00",
      currencyCode: "usd",
      scheduledAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolvePayout, initialPayoutState);

    const failedState = decidePayout(scheduledState, {
      type: "FailPayout",
      failureReason: "Bank rejected transfer",
      failedAt: "2026-04-02T01:00:00.000Z",
    }).reduce(evolvePayout, scheduledState);

    expect(failedState.status).toBe("failed");
    expect(
      decidePayout(failedState, {
        type: "FailPayout",
        failureReason: "Bank rejected transfer",
        failedAt: "2026-04-02T01:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects completion after failure", () => {
    const failedState = [
      {
        type: "SchedulePayout" as const,
        payoutId: "pyo_1" as never,
        accountId: "acc_seller" as never,
        amount: "25.00",
        currencyCode: "usd" as const,
        scheduledAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "FailPayout" as const,
        failureReason: "Rejected",
        failedAt: "2026-04-02T01:00:00.000Z",
      },
    ].reduce(
      (state, command) => decidePayout(state, command).reduce(evolvePayout, state),
      initialPayoutState,
    );

    expect(() =>
      decidePayout(failedState, {
        type: "CompletePayout",
        completedAt: "2026-04-02T02:00:00.000Z",
      }),
    ).toThrow("Only scheduled or in-transit payouts can complete.");
  });
});

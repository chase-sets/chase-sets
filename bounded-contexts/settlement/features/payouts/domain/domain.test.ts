import { describe, expect, it } from "vitest";
import {
  decidePayout,
  evolvePayout,
  evolvePayoutMonth,
  initialPayoutMonthState,
  initialPayoutState,
  payoutMonthHasActivePayout,
  payoutMonthStreamId,
  payoutUtcMonthWindow,
  planPayoutMonthFailure,
  type PayoutRequestedEvent,
} from "./domain";

describe("settlement payout domain", () => {
  it("requests, sends, and completes a payout", () => {
    const requestedState = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      requestedAmount: "25.00",
      feeAmount: "1.00",
      netAmount: "24.00",
      currencyCode: "usd",
      destinationReference: "bank_123",
      note: "Weekly payout",
      requestedAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolvePayout, initialPayoutState);

    const sentState = decidePayout(requestedState, {
      type: "MarkPayoutInTransit",
      sentAt: "2026-04-02T01:00:00.000Z",
    }).reduce(evolvePayout, requestedState);

    const completedState = decidePayout(sentState, {
      type: "CompletePayout",
      completedAt: "2026-04-02T02:00:00.000Z",
    }).reduce(evolvePayout, sentState);

    expect(completedState.status).toBe("completed");
    expect(completedState.sentAt).toBe("2026-04-02T01:00:00.000Z");
    expect(completedState.completedAt).toBe("2026-04-02T02:00:00.000Z");
    expect(
      decidePayout(completedState, {
        type: "CompletePayout",
        completedAt: "2026-04-03T02:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("carries requested, fee, and net amounts through every lifecycle event", () => {
    const requestedEvents = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_amounts" as never,
      accountId: "acc_seller" as never,
      requestedAmount: "25.00",
      feeAmount: "1.00",
      netAmount: "24.00",
      currencyCode: "usd",
      requestedAt: "2026-04-02T00:00:00.000Z",
    });
    const requested = requestedEvents.reduce(evolvePayout, initialPayoutState);
    const inTransitEvents = decidePayout(requested, {
      type: "MarkPayoutInTransit",
      sentAt: "2026-04-02T01:00:00.000Z",
    });
    const inTransit = inTransitEvents.reduce(evolvePayout, requested);
    const completedEvents = decidePayout(inTransit, {
      type: "CompletePayout",
      completedAt: "2026-04-02T02:00:00.000Z",
    });
    const failedEvents = decidePayout(inTransit, {
      type: "FailPayout",
      failedAt: "2026-04-02T02:00:00.000Z",
    });

    for (const event of [...requestedEvents, ...inTransitEvents, ...completedEvents, ...failedEvents]) {
      expect(event.data).toMatchObject({
        requestedAmount: "25.00",
        feeAmount: "1.00",
        netAmount: "24.00",
      });
    }
    expect(completedEvents[0]).toMatchObject({
      type: "settlement.payout.completed",
      data: {
        amount: "25.00",
        requestedAmount: "25.00",
        feeAmount: "1.00",
        netAmount: "24.00",
      },
    });
  });

  it("records provider references without changing payout status", () => {
    const requestedState = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      requestedAmount: "25.00",
      feeAmount: "1.00",
      netAmount: "24.00",
      currencyCode: "usd",
      requestedAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolvePayout, initialPayoutState);

    const referencedState = decidePayout(requestedState, {
      type: "RecordPayoutProviderReferences",
      providerTransferReference: "tr_1",
      providerPayoutReference: "po_1",
      providerStatus: "pending",
      recordedAt: "2026-04-02T00:01:00.000Z",
    }).reduce(evolvePayout, requestedState);

    expect(referencedState.status).toBe("requested");
    expect(referencedState.providerTransferReference).toBe("tr_1");
    expect(referencedState.providerPayoutReference).toBe("po_1");
  });

  it("fails idempotently", () => {
    const requestedState = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      requestedAmount: "25.00",
      feeAmount: "1.00",
      netAmount: "24.00",
      currencyCode: "usd",
      requestedAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolvePayout, initialPayoutState);

    const failedState = decidePayout(requestedState, {
      type: "FailPayout",
      failureReason: "Bank rejected transfer",
      failedAt: "2026-04-02T01:00:00.000Z",
    }).reduce(evolvePayout, requestedState);

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
        type: "RequestPayout" as const,
        payoutId: "pyo_1" as never,
        accountId: "acc_seller" as never,
        requestedAmount: "25.00",
        feeAmount: "1.00",
        netAmount: "24.00",
        currencyCode: "usd" as const,
        requestedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "FailPayout" as const,
        failureReason: "Rejected",
        failedAt: "2026-04-02T01:00:00.000Z",
      },
    ].reduce((state, command) => decidePayout(state, command).reduce(evolvePayout, state), initialPayoutState);

    expect(() =>
      decidePayout(failedState, {
        type: "CompletePayout",
        completedAt: "2026-04-02T02:00:00.000Z",
      }),
    ).toThrow("Only requested or in-transit payouts can complete.");
  });

  it("payout-fee-legacy-replay evolves a historical request with zero fee and net equal to requested", () => {
    const legacyEvent = {
      type: "settlement.payout.requested",
      data: {
        payoutId: "pyo_legacy" as never,
        accountId: "acc_seller" as never,
        amount: "25.00",
        currencyCode: "usd",
        destinationReference: null,
        note: null,
        notificationEmail: null,
        requestedAt: "2026-04-02T00:00:00.000Z",
      },
    } satisfies PayoutRequestedEvent;

    expect(evolvePayout(initialPayoutState, legacyEvent)).toMatchObject({
      requestedAmount: "25.00",
      feeAmount: "0.00",
      netAmount: "25.00",
    });
  });

  it("derives exact UTC calendar-month boundaries", () => {
    expect(payoutUtcMonthWindow("2026-12-31T23:59:59.999Z")).toEqual({
      startsAt: "2026-12-01T00:00:00.000Z",
      endsAt: "2027-01-01T00:00:00.000Z",
    });
    expect(payoutUtcMonthWindow("2026-08-31T19:00:00.000-05:00")).toEqual({
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-10-01T00:00:00.000Z",
    });
    expect(payoutMonthStreamId("acc_utc" as never, "2026-08-31T19:00:00.000-05:00")).toBe(
      "settlement.payout-month-acc_utc-2026-09",
    );
  });

  it("releases each retained active payout by identity", () => {
    const firstFailure = planPayoutMonthFailure(initialPayoutMonthState, {
      accountId: "acc_retained" as never,
      payoutId: "pyo_retained_a" as never,
      failedAt: "2026-09-11T01:00:00.000Z",
      baselineActivePayoutIds: ["pyo_retained_a" as never, "pyo_retained_b" as never],
    });
    const afterFirstFailure = firstFailure.reduce(evolvePayoutMonth, initialPayoutMonthState);
    expect(afterFirstFailure.activePayoutIds).toEqual(["pyo_retained_b"]);
    expect(payoutMonthHasActivePayout(afterFirstFailure)).toBe(true);

    const secondFailure = planPayoutMonthFailure(afterFirstFailure, {
      accountId: "acc_retained" as never,
      payoutId: "pyo_retained_b" as never,
      failedAt: "2026-09-11T02:00:00.000Z",
      baselineActivePayoutIds: [],
    });
    const afterBothFailures = secondFailure.reduce(evolvePayoutMonth, afterFirstFailure);
    expect(afterBothFailures.activePayoutIds).toEqual([]);
    expect(payoutMonthHasActivePayout(afterBothFailures)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { decidePayout, evolvePayout, initialPayoutState } from "./domain";

describe("settlement payout domain", () => {
  it("requests, sends, and completes a payout", () => {
    const requestedState = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      amount: "25.00",
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
  });

  it("records provider references without changing payout status", () => {
    const requestedState = decidePayout(initialPayoutState, {
      type: "RequestPayout",
      payoutId: "pyo_1" as never,
      accountId: "acc_seller" as never,
      amount: "25.00",
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
      amount: "25.00",
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
        amount: "25.00",
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
});

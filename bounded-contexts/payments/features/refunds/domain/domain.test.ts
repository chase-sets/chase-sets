import { describe, expect, it } from "vitest";
import { decideRefund, evolveRefund, initialRefundState } from "./domain";

describe("payments refund domain", () => {
  const requestRefund = {
    type: "RequestRefund",
    refundId: "rfd_1" as never,
    paymentId: "pay_1" as never,
    orderIds: ["ord_1" as never],
    amount: "10.00",
    currencyCode: "usd",
    reason: "Item was unavailable.",
    processorName: "stripe",
    requestedAt: "2026-04-01T00:00:00.000Z",
  } as const;

  it("requests and issues a refund", () => {
    const requestedState = decideRefund(initialRefundState, requestRefund).reduce(evolveRefund, initialRefundState);

    const issuedState = decideRefund(requestedState, {
      type: "RecordRefundIssued",
      processorRefundReference: "re_123",
      processorStatus: "succeeded",
      issuedAt: "2026-04-01T00:10:00.000Z",
    }).reduce(evolveRefund, requestedState);

    expect(issuedState.status).toBe("issued");
    expect(issuedState.processorRefundReference).toBe("re_123");
  });

  it("treats an identical refund request replay as idempotent", () => {
    const requestedState = decideRefund(initialRefundState, requestRefund).reduce(evolveRefund, initialRefundState);

    expect(
      decideRefund(requestedState, {
        ...requestRefund,
        requestedAt: "2026-04-01T00:10:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects a refund request replay with different business facts", () => {
    const requestedState = decideRefund(initialRefundState, requestRefund).reduce(evolveRefund, initialRefundState);

    expect(() =>
      decideRefund(requestedState, {
        ...requestRefund,
        amount: "11.00",
      }),
    ).toThrow("Refund request does not match the existing refund.");
  });
});

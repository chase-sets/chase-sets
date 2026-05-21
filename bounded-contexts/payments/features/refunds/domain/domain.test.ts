import { describe, expect, it } from "vitest";
import { decideRefund, evolveRefund, initialRefundState } from "./domain";

describe("payments refund domain", () => {
  it("requests and issues a refund", () => {
    const requestedState = decideRefund(initialRefundState, {
      type: "RequestRefund",
      refundId: "rfd_1" as never,
      paymentId: "pay_1" as never,
      orderIds: ["ord_1" as never],
      amount: "10.00",
      currencyCode: "usd",
      reason: "Item was unavailable.",
      processorName: "stripe",
      requestedAt: "2026-04-01T00:00:00.000Z",
    }).reduce(evolveRefund, initialRefundState);

    const issuedState = decideRefund(requestedState, {
      type: "RecordRefundIssued",
      processorRefundReference: "re_123",
      processorStatus: "succeeded",
      issuedAt: "2026-04-01T00:10:00.000Z",
    }).reduce(evolveRefund, requestedState);

    expect(issuedState.status).toBe("issued");
    expect(issuedState.processorRefundReference).toBe("re_123");
  });
});

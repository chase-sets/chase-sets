import { describe, expect, it } from "vitest";
import { decideRefund, evolveRefund, initialRefundState, type RefundCommand, type RefundState } from "./domain";

function decide(state: RefundState, command: RefundCommand) {
  return decideRefund(state, command);
}

function evolve(state: RefundState, command: RefundCommand) {
  return decide(state, command).reduce(evolveRefund, state);
}

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

  const recordIssued = {
    type: "RecordRefundIssued",
    processorRefundReference: "re_123",
    processorStatus: "succeeded",
    issuedAt: "2026-04-01T00:10:00.000Z",
  } as const;

  const recordFailure = {
    type: "RecordRefundFailure",
    processorStatus: "failed",
    failureCode: "processor_unavailable",
    failureMessage: " Stripe was unavailable. ",
    failedAt: "2026-04-01T00:05:00.000Z",
  } as const;

  it("requests a refund with the complete normalized provider payload", () => {
    expect(
      decide(initialRefundState, {
        ...requestRefund,
        orderIds: ["ord_1" as never, "ord_1" as never],
        amount: "10",
        currencyCode: "usd",
        reason: " Item was unavailable. ",
        processorName: "stripe",
      }),
    ).toEqual([
      {
        type: "payments.refund-requested",
        data: {
          refundId: "rfd_1",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Item was unavailable.",
          processorName: "stripe",
          requestedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    ]);
  });

  it("records issuance with the complete payment and order payload", () => {
    const requestedState = evolve(initialRefundState, requestRefund);

    const issuedEvents = decide(requestedState, recordIssued);

    expect(issuedEvents).toEqual([
      {
        type: "payments.refund-issued",
        data: {
          refundId: "rfd_1",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Item was unavailable.",
          processorName: "stripe",
          processorRefundReference: "re_123",
          processorStatus: "succeeded",
          issuedAt: "2026-04-01T00:10:00.000Z",
        },
      },
    ]);
    expect(issuedEvents.reduce(evolveRefund, requestedState)).toMatchObject({
      status: "issued",
      processorRefundReference: "re_123",
      processorStatus: "succeeded",
      issuedAt: "2026-04-01T00:10:00.000Z",
    });
  });

  it("treats a duplicate issuance as idempotent", () => {
    const requestedState = evolve(initialRefundState, requestRefund);
    const issuedState = evolve(requestedState, recordIssued);

    expect(
      decide(issuedState, {
        type: "RecordRefundIssued",
        processorRefundReference: "re_duplicate",
        processorStatus: "pending",
        issuedAt: "2026-04-01T00:20:00.000Z",
      }),
    ).toEqual([]);
  });

  it("records failure with the complete normalized payment and order payload", () => {
    const requestedState = evolve(initialRefundState, requestRefund);

    const failedEvents = decide(requestedState, recordFailure);

    expect(failedEvents).toEqual([
      {
        type: "payments.refund-failed",
        data: {
          refundId: "rfd_1",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Item was unavailable.",
          processorName: "stripe",
          processorStatus: "failed",
          failureCode: "processor_unavailable",
          failureMessage: "Stripe was unavailable.",
          failedAt: "2026-04-01T00:05:00.000Z",
        },
      },
    ]);
    expect(failedEvents.reduce(evolveRefund, requestedState)).toMatchObject({
      status: "failed",
      processorStatus: "failed",
      failureCode: "processor_unavailable",
      failureMessage: "Stripe was unavailable.",
      failedAt: "2026-04-01T00:05:00.000Z",
    });
  });

  it("treats a duplicate failure as idempotent", () => {
    const requestedState = evolve(initialRefundState, requestRefund);
    const failedState = evolve(requestedState, recordFailure);

    expect(
      decide(failedState, {
        ...recordFailure,
        failureCode: "different_code",
        failureMessage: "A later provider message.",
        failedAt: "2026-04-01T00:20:00.000Z",
      }),
    ).toEqual([]);
  });

  it("allows provider issuance after a retryable failure", () => {
    const requestedState = evolve(initialRefundState, requestRefund);
    const failedState = evolve(requestedState, recordFailure);

    expect(decide(failedState, recordIssued)).toEqual([
      {
        type: "payments.refund-issued",
        data: {
          refundId: "rfd_1",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Item was unavailable.",
          processorName: "stripe",
          processorRefundReference: "re_123",
          processorStatus: "succeeded",
          issuedAt: "2026-04-01T00:10:00.000Z",
        },
      },
    ]);
  });

  it("rejects a provider failure after the refund was issued", () => {
    const requestedState = evolve(initialRefundState, requestRefund);
    const issuedState = evolve(requestedState, recordIssued);

    expect(() => decide(issuedState, recordFailure)).toThrow("Issued refunds cannot fail.");
  });

  it.each([
    ["issuance", recordIssued],
    ["failure", recordFailure],
  ] as const)("rejects %s before the refund is requested", (_name, command) => {
    expect(() => decide(initialRefundState, command)).toThrow("Refund must be requested first.");
  });

  it("treats an identical refund request replay as idempotent", () => {
    const requestedState = evolve(initialRefundState, requestRefund);

    expect(
      decide(requestedState, {
        ...requestRefund,
        requestedAt: "2026-04-01T00:10:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects a refund request replay with different business facts", () => {
    const requestedState = evolve(initialRefundState, requestRefund);

    expect(() =>
      decide(requestedState, {
        ...requestRefund,
        amount: "11.00",
      }),
    ).toThrow("Refund request does not match the existing refund.");
  });
});

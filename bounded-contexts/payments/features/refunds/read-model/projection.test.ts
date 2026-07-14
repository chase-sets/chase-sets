import { describe, expect, it, vi } from "vitest";
import { buildRefundProjectionHandlers } from "./projection";

function baseEvent() {
  return {
    tenantId: "tnt_test",
    streamId: "payments.refund-rfd_1",
    streamVersion: 1,
    eventId: "evt_1",
    globalPosition: "1",
    timing: { occurredAt: "2026-06-01T00:00:00.000Z", recordedAt: "2026-06-01T00:00:00.000Z" },
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    trace: null,
  };
}

describe("payments refund read-model projection", () => {
  it("persists remedy and allocation causation columns for a platform-coverage refund", async () => {
    const db = { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 0 })) };
    const handlers = buildRefundProjectionHandlers(db as never);

    await handlers["payments.refund-requested"]?.({
      ...baseEvent(),
      type: "payments.refund-requested",
      data: {
        refundId: "rfd_1",
        paymentId: "pay_1",
        orderIds: ["ord_1"],
        amount: "12.00",
        currencyCode: "usd",
        reason: "Support sup_1: platform-coverage remedy refund released.",
        processorName: "stripe",
        causation: {
          remedyId: "rmd_1",
          coverageId: "cov_1",
          allocation: {
            sellerFundedAmount: "0.00",
            platformFundedAmount: "12.00",
            currencyCode: "usd",
            fundingKind: "platform-funded",
          },
          reasonCode: "platform-coverage-remedy-refund-released",
          refundTrigger: "immediate",
          refundTriggerEvidenceRef: "fct_trigger",
          policyVersion: "policy_1",
        },
        requestedAt: "2026-06-01T00:00:00.000Z",
      },
    } as never);

    const params = db.query.mock.calls[0]?.[1];
    expect(params).toEqual(
      expect.arrayContaining([
        "rmd_1",
        "cov_1",
        "platform-funded",
        "0.00",
        "12.00",
        "immediate",
        "platform-coverage-remedy-refund-released",
      ]),
    );
  });

  it("leaves causation columns null for a legacy seller-funded refund with no causation", async () => {
    const db = { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 0 })) };
    const handlers = buildRefundProjectionHandlers(db as never);

    await handlers["payments.refund-requested"]?.({
      ...baseEvent(),
      type: "payments.refund-requested",
      data: {
        refundId: "rfd_2",
        paymentId: "pay_2",
        orderIds: ["ord_2"],
        amount: "5.00",
        currencyCode: "usd",
        reason: "Support sup_2: refund approved",
        processorName: "stripe",
        requestedAt: "2026-06-01T00:00:00.000Z",
      },
    } as never);

    const params = db.query.mock.calls[0]?.[1] ?? [];
    // remedy_id, coverage_id, funding_kind, seller_funded, platform_funded, refund_trigger, reason_code
    expect(params.slice(7, 14)).toEqual([null, null, null, null, null, null, null]);
  });
});

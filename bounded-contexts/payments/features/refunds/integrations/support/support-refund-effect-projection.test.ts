import { describe, expect, it, vi } from "vitest";
import { buildPaymentsSupportRefundEffectHandlers } from "./support-refund-effect-projection";

describe("payments support refund effect projection", () => {
  it("records a concrete support refund effect id for launch evidence", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [{ payment_id: "pay_1" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        if (sql.includes("INSERT INTO payments_support_refund_effects")) {
          return { rowCount: 1, rows: [{ support_request_id: "sup_01ABC", refund_id: "rfd_support" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.resolved"]?.({
      tenantId: "tnt_test",
      streamId: "support.support-request-sup_01ABC",
      streamVersion: 3,
      eventId: "evt_1",
      globalPosition: "1",
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        resolution: {
          resolutionType: "partial-refund",
          refundAmount: "1.00",
          summary: "Controlled support refund.",
          resolvedAt: "2026-05-31T14:00:00.000Z",
        },
      },
      timing: {
        occurredAt: "2026-05-31T14:00:00.000Z",
        recordedAt: "2026-05-31T14:00:00.000Z",
      },
      audit: {
        performedByUserId: "usr_test",
        forAccountId: "acc_buyer",
      },
      trace: null,
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("refund_effect_id"), [
      "sup_01ABC",
      "sre_01ABC",
      "ord_1",
      "pay_1",
      expect.any(String),
      "partial-refund",
      "1.00",
      "2026-05-31T14:00:00.000Z",
    ]);
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: "rfd_support", paymentId: "pay_1", amount: "1.00" }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
  });
});

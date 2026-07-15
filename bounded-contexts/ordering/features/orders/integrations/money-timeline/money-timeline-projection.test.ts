import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { buildOrderingMoneyTimelineProjectionHandlers } from "./money-timeline-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1) {
  return buildTransportEvent(type, data, {
    id: `evt_${type}`,
    streamId: "stream_1",
    streamVersion,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-07-15T00:00:00.000Z", recordedAt: "2026-07-15T00:00:00.000Z" },
  });
}

function createDb() {
  const query = vi.fn<(sql: string, params?: readonly unknown[]) => Promise<{ rows: never[]; rowCount: number }>>(
    async () => ({ rows: [], rowCount: 1 }),
  );
  return { db: { query } as unknown as PgQueryable, query };
}

describe("ordering money timeline projection", () => {
  it("projects refund progress for every affected order without processor details", async () => {
    const { db, query } = createDb();
    const handlers = buildOrderingMoneyTimelineProjectionHandlers(db);

    await handlers["payments.refund-requested"]!(
      event("payments.refund-requested", {
        refundId: "rfd_1",
        paymentId: "pay_1",
        orderIds: ["ord_1", "ord_2"],
        amount: "15.00",
        currencyCode: "usd",
        reason: "Support sup_1: approved refund",
        processorName: "stripe",
        requestedAt: "2026-07-15T00:00:00.000Z",
      }),
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("ordering_order_refund_timeline_pages");
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["rfd_1", "ord_1", "pay_1", null, "USD", "2026-07-15T00:00:00.000Z"]),
    );
    expect(query.mock.calls[0]?.[1]).not.toEqual(expect.arrayContaining(["stripe"]));

    await handlers["payments.refund-issued"]!(
      event(
        "payments.refund-issued",
        {
          refundId: "rfd_1",
          orderIds: ["ord_1", "ord_2"],
          processorRefundReference: "provider-secret",
          processorStatus: "succeeded",
          issuedAt: "2026-07-16T00:00:00.000Z",
        },
        2,
      ),
    );

    expect(query.mock.calls.at(-1)?.[0]).toContain("status = 'issued'");
    expect(query.mock.calls.at(-1)?.[1]).toEqual(["rfd_1", "2026-07-16T00:00:00.000Z", 2]);
    expect(query.mock.calls.at(-1)?.[1]).not.toEqual(expect.arrayContaining(["provider-secret", "succeeded"]));
  });

  it("projects customer-safe refund failure state", async () => {
    const { db, query } = createDb();
    const handlers = buildOrderingMoneyTimelineProjectionHandlers(db);

    await handlers["payments.refund-failed"]!(
      event(
        "payments.refund-failed",
        {
          refundId: "rfd_1",
          orderIds: ["ord_1"],
          processorStatus: "failed",
          failureCode: "processor_declined",
          failureMessage: "internal processor detail",
          failedAt: "2026-07-16T00:00:00.000Z",
        },
        2,
      ),
    );

    expect(query.mock.calls[0]?.[0]).toContain("status = 'failed'");
    expect(query.mock.calls[0]?.[1]).toEqual(["rfd_1", "2026-07-16T00:00:00.000Z", 2]);
  });

  it("projects support holds and releases non-refund resolutions", async () => {
    const { db, query } = createDb();
    const handlers = buildOrderingMoneyTimelineProjectionHandlers(db);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        flowType: "product-damaged",
        status: "waiting-on-seller",
        openedAt: "2026-07-15T00:00:00.000Z",
      }),
    );

    expect(query.mock.calls[0]?.[0]).toContain("ordering_order_support_money_pages");
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["sup_1", "ord_1", "acc_buyer", "acc_seller", "product-damaged"]),
    );

    await handlers["support.support-request.resolved"]!(
      event(
        "support.support-request.resolved",
        {
          supportRequestId: "sup_1",
          orderId: "ord_1",
          resolution: {
            resolutionType: "replacement-sent",
            refundAmount: null,
            resolvedAt: "2026-07-16T00:00:00.000Z",
          },
        },
        2,
      ),
    );

    expect(query.mock.calls.at(-1)?.[0]).toContain("active_hold = $4");
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      "sup_1",
      "replacement-sent",
      null,
      false,
      "2026-07-16T00:00:00.000Z",
      2,
    ]);
  });

  it("keeps refund holds active until settlement reconciliation completes", async () => {
    const { db, query } = createDb();
    const handlers = buildOrderingMoneyTimelineProjectionHandlers(db);

    await handlers["support.support-request.resolved"]!(
      event(
        "support.support-request.resolved",
        {
          supportRequestId: "sup_1",
          orderId: "ord_1",
          resolution: {
            resolutionType: "partial-refund",
            refundAmount: "8.00",
            resolvedAt: "2026-07-16T00:00:00.000Z",
          },
        },
        2,
      ),
    );

    expect(query.mock.calls[0]?.[1]).toEqual(["sup_1", "partial-refund", "8.00", true, "2026-07-16T00:00:00.000Z", 2]);

    await handlers["settlement.protection-coverage.settled.v1"]!(
      event(
        "settlement.protection-coverage.settled.v1",
        { supportRequestId: "sup_1", occurredAt: "2026-07-17T00:00:00.000Z" },
        3,
      ),
    );

    expect(query.mock.calls.at(-1)?.[0]).toContain("ordering_order_hold_reconciliations");
    expect(query.mock.calls.at(-1)?.[1]).toEqual(["sup_1", "2026-07-17T00:00:00.000Z", 3]);
  });

  it("projects actual per-order refunded totals", async () => {
    const { db, query } = createDb();
    const handlers = buildOrderingMoneyTimelineProjectionHandlers(db);

    await handlers["payments.payment-refunded"]!(
      event("payments.payment-refunded", {
        paymentId: "pay_1",
        refundId: "rfd_1",
        currencyCode: "usd",
        orderRefundAmounts: [
          { orderId: "ord_1", amount: "5.00" },
          { orderId: "ord_2", amount: "10.00" },
        ],
        refundedOrderAmounts: [
          { orderId: "ord_1", amount: "7.00" },
          { orderId: "ord_2", amount: "10.00" },
        ],
        refundedAt: "2026-07-16T00:00:00.000Z",
      }),
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("ordering_order_refund_totals");
    expect(query.mock.calls[0]?.[1]).toEqual(["ord_1", "7.00", "USD", "2026-07-16T00:00:00.000Z"]);
  });
});

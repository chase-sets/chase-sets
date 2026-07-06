import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildSettlementSupportHoldProjectionHandlers } from "./support-source-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return {
    id: `evt_${streamVersion}` as never,
    type,
    streamId: "support.support-request-sup_01ABC" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_test" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: "acc_buyer" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-31T14:00:00.000Z" as never,
      recordedAt: "2026-05-31T14:00:00.000Z" as never,
    },
  };
}

describe("settlement support source projection", () => {
  it("records a concrete support hold id for launch evidence", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        flowType: "product-damaged",
        status: "waiting-on-seller",
        openedAt: "2026-05-31T14:00:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("hold_id"), [
      "sup_01ABC",
      "hold_01ABC",
      "ord_1",
      "acc_buyer",
      "acc_seller",
      "product-damaged",
      "waiting-on-seller",
      "2026-05-31T14:00:00.000Z",
      1,
    ]);
  });

  it("records Stripe early fraud warnings as active seller holds", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        {
          orderIds: ["ord_1"],
          buyerAccountId: "acc_buyer",
          sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
          earlyFraudWarningId: "issfr_123",
          receivedAt: "2026-07-06T12:05:00.000Z",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("settlement_support_holds"), [
      "fraud_issfr_123_ord_1_acc_seller",
      "hold_fraud_issfr_123_ord_1_acc_seller",
      "ord_1",
      "acc_buyer",
      "acc_seller",
      "stripe-early-fraud-warning",
      "opened",
      "2026-07-06T12:05:00.000Z",
      2,
    ]);
  });

  it("releases Radar review holds only after approval", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-review-opened"]!(
      event(
        "payments.payment-fraud-review-opened",
        {
          orderIds: ["ord_1"],
          buyerAccountId: "acc_buyer",
          sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
          providerReviewId: "prv_123",
          openedAt: "2026-07-06T12:05:00.000Z",
        },
        3,
      ),
    );
    await handlers["payments.payment-fraud-review-closed"]!(
      event(
        "payments.payment-fraud-review-closed",
        {
          providerReviewId: "prv_123",
          outcome: "approved",
          closedAt: "2026-07-06T12:10:00.000Z",
        },
        4,
      ),
    );

    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("stripe-review-approved"), [
      "fraud_prv_123%",
      "2026-07-06T12:10:00.000Z",
      4,
    ]);
  });
});

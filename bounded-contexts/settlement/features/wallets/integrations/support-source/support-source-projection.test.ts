import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildSettlementSupportHoldProjectionHandlers } from "./support-source-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "support.support-request-sup_01ABC",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-05-31T14:00:00.000Z", recordedAt: "2026-05-31T14:00:00.000Z" },
  });
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

  it("holds pending seller funds for chargebacks and releases them when won", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["payments.payment-disputed"]!(
      event(
        "payments.payment-disputed",
        {
          orderIds: ["ord_1"],
          buyerAccountId: "acc_buyer",
          sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
          providerDisputeId: "dp_123",
          disputeLifecycleState: "created",
          disputedAt: "2026-07-06T12:05:00.000Z",
        },
        5,
      ),
    );
    await handlers["payments.payment-disputed"]!(
      event(
        "payments.payment-disputed",
        {
          orderIds: ["ord_1"],
          buyerAccountId: "acc_buyer",
          sellerPayouts: [{ orderId: "ord_1", sellerAccountId: "acc_seller" }],
          providerDisputeId: "dp_123",
          disputeLifecycleState: "won",
          disputedAt: "2026-07-08T12:05:00.000Z",
        },
        6,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("settlement_support_holds"), [
      "fraud_dp_123_ord_1_acc_seller",
      "hold_fraud_dp_123_ord_1_acc_seller",
      "ord_1",
      "acc_buyer",
      "acc_seller",
      "stripe-chargeback",
      "created",
      "2026-07-06T12:05:00.000Z",
      5,
    ]);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("stripe-chargeback-won"), [
      "fraud_dp_123%",
      "2026-07-08T12:05:00.000Z",
      6,
    ]);
  });

  it("releases the correlated support hold only after the coverage settlement is reconciled", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["settlement.protection-coverage.settled.v1"]!(
      event(
        "settlement.protection-coverage.settled.v1",
        {
          factSchemaVersion: 1,
          supportRequestId: "sup_01ABC",
          remedyId: "rmd_1",
          coverageId: "cov_1",
          refundId: "rfd_1",
          idempotencyKey: "coverage-settle:cov_1",
          causationId: null,
          policyVersion: "coverage-policy-2026-07",
          occurredAt: "2026-07-09T12:00:00.000Z",
        },
        7,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("coverage-reconciled"), [
      "sup_01ABC",
      "2026-07-09T12:00:00.000Z",
      7,
    ]);
  });
});

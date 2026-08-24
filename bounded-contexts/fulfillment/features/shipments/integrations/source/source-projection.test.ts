import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildFulfillmentAccountProjectionHandlers,
  buildFulfillmentOrderProjectionHandlers,
} from "./source-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "payments.payment-pay_123",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-07-06T12:00:00.000Z", recordedAt: "2026-07-06T12:00:00.000Z" },
  });
}

describe("fulfillment account enforcement payload compatibility", () => {
  it("ignores additive modern enforcement data for every lifecycle status", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildFulfillmentAccountProjectionHandlers({ query } as never);
    for (const [type, status, reason] of [
      ["identity.account.suspended", "suspended", "payment-risk"],
      ["identity.account.reactivated", "active", "issue-resolved"],
      ["identity.account.closed", "closed", "seller-requested"],
    ] as const) {
      await handlers[type]!(
        buildTransportEvent(
          type,
          {
            enforcement: {
              version: 1,
              enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
              reason,
              reference: null,
            },
          },
          {
            streamId: "identity.account-acc_compat",
            timing: {
              occurredAt: "2026-08-19T00:00:00.000Z",
              recordedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        ),
      );
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining(`status = '${status}'`), [
        "acc_compat",
        "2026-08-19T00:00:00.000Z",
      ]);
    }
  });
});

describe("fulfillment payment fraud source projection", () => {
  it("cancels unshipped fulfillment for each order on early fraud warnings", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const onFraudWarningReceived = vi.fn(async () => undefined);
    const handlers = buildFulfillmentOrderProjectionHandlers(db as never, { onFraudWarningReceived });

    await handlers["payments.payment-fraud-warning-received"]!(
      event("payments.payment-fraud-warning-received", {
        orderIds: ["ord_1", "ord_2"],
        receivedAt: "2026-07-06T12:05:00.000Z",
      }),
    );

    expect(onFraudWarningReceived).toHaveBeenCalledTimes(2);
    expect(onFraudWarningReceived).toHaveBeenNthCalledWith(1, {
      orderId: "ord_1",
      receivedAt: "2026-07-06T12:05:00.000Z",
      context: expect.objectContaining({ tenantId: "tnt_test" }),
      sourceIdentity: expect.objectContaining({
        eventId: "evt_1",
        eventType: "payments.payment-fraud-warning-received",
        streamVersion: 1,
      }),
    });
    expect(onFraudWarningReceived).toHaveBeenNthCalledWith(2, {
      orderId: "ord_2",
      receivedAt: "2026-07-06T12:05:00.000Z",
      context: expect.objectContaining({ tenantId: "tnt_test" }),
      sourceIdentity: expect.objectContaining({
        eventId: "evt_1",
        eventType: "payments.payment-fraud-warning-received",
        streamVersion: 1,
      }),
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("records and releases Stripe Radar review fulfillment holds", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildFulfillmentOrderProjectionHandlers(db as never);

    await handlers["payments.payment-fraud-review-opened"]!(
      event(
        "payments.payment-fraud-review-opened",
        {
          paymentId: "pay_123",
          orderIds: ["ord_1"],
          buyerAccountId: "acc_buyer",
          providerReviewId: "prv_123",
          openedAt: "2026-07-06T12:05:00.000Z",
        },
        3,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_payment_fraud_review_holds"), [
      "prv_123",
      "pay_123",
      JSON.stringify(["ord_1"]),
      "acc_buyer",
      "2026-07-06T12:05:00.000Z",
      3,
    ]);

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

    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'closed'"), [
      "prv_123",
      "approved",
      "2026-07-06T12:10:00.000Z",
      4,
    ]);
  });
});

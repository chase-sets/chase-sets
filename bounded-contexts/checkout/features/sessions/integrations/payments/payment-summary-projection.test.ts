import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutPaymentSummaryProjectionHandlers } from "./payment-summary-projection";

type PaymentSummaryRow = {
  payment_id: string;
  buyer_account_id: string | null;
  order_ids: string[];
  amount: string;
  currency_code: string;
  status: string;
  updated_at: string;
  last_stream_version: number;
};

class PaymentSummaryProjectionDb implements PgQueryable {
  public readonly summaries = new Map<string, PaymentSummaryRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_payment_summary_pages")) {
      const paymentId = String(values[0]);
      const streamVersion = Number(values[6]);
      const existing = this.summaries.get(paymentId);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.summaries.set(paymentId, {
          payment_id: paymentId,
          buyer_account_id: String(values[1]),
          order_ids: JSON.parse(String(values[2])) as string[],
          amount: String(values[3]),
          currency_code: String(values[4]),
          status: "pending-confirmation",
          updated_at: String(values[5]),
          last_stream_version: streamVersion,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("UPDATE checkout_payment_summary_pages")) {
      const paymentId = String(values[0]);
      const streamVersion = Number(values[3]);
      const existing = this.summaries.get(paymentId);
      if (existing && existing.last_stream_version < streamVersion) {
        this.summaries.set(paymentId, {
          ...existing,
          status: String(values[1]),
          updated_at: String(values[2]),
          last_stream_version: streamVersion,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, streamVersion: number, data: Record<string, unknown>): TransportEvent {
  return {
    id: `evt_${streamVersion}` as never,
    type,
    streamId: "payments.payment-pay_1" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_buyer" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-29T00:00:00.000Z" as never,
      recordedAt: "2026-06-29T00:00:00.000Z" as never,
    },
  };
}

describe("checkout payment summary projection", () => {
  it("mirrors the payment confirmation summary and ignores stale replays", async () => {
    const db = new PaymentSummaryProjectionDb();
    const handlers = buildCheckoutPaymentSummaryProjectionHandlers(db);

    await handlers["payments.payment-created"]!(
      event("payments.payment-created", 1, {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        orderIds: ["ord_1"],
        amount: "27.29",
        currencyCode: "usd",
        createdAt: "2026-06-29T00:00:00.000Z",
      }),
    );
    await handlers["payments.payment-captured"]!(
      event("payments.payment-captured", 2, {
        paymentId: "pay_1",
        capturedAt: "2026-06-29T00:01:00.000Z",
      }),
    );
    await handlers["payments.payment-created"]!(
      event("payments.payment-created", 1, {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        orderIds: ["ord_1"],
        amount: "27.29",
        currencyCode: "usd",
        createdAt: "2026-06-29T00:00:00.000Z",
      }),
    );

    expect(db.summaries.get("pay_1")).toMatchObject({
      payment_id: "pay_1",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_1"],
      amount: "27.29",
      currency_code: "usd",
      status: "captured",
      updated_at: "2026-06-29T00:01:00.000Z",
      last_stream_version: 2,
    });
  });

  it("does not create a status-only row before the payment-created event arrives", async () => {
    const db = new PaymentSummaryProjectionDb();
    const handlers = buildCheckoutPaymentSummaryProjectionHandlers(db);

    await handlers["payments.payment-cancelled"]!(
      event("payments.payment-cancelled", 2, {
        paymentId: "pay_missing",
        cancelledAt: "2026-06-29T00:01:00.000Z",
      }),
    );

    expect(db.summaries.has("pay_missing")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildOrderingOrderProjectionHandlers } from "./projection";

type OrderPageRow = {
  order_id: string;
  display_reference: string;
  source_type: string;
  source_reference_id: string | null;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
  total_amount: string;
};

class OrderProjectionDb implements PgQueryable {
  public readonly orders = new Map<string, OrderPageRow>();
  public readonly lines = new Map<string, unknown>();
  public readonly holds = new Map<string, unknown>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO ordering_order_pages")) {
      const row: OrderPageRow = {
        order_id: String(values[0]),
        display_reference: String(values[1]),
        source_type: String(values[2]),
        source_reference_id: values[3] === null ? null : String(values[3]),
        buyer_account_id: String(values[4]),
        seller_account_id: String(values[5]),
        status: "pending-reservation",
        total_amount: String(values[21]),
      };
      this.orders.set(row.order_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("DELETE FROM ordering_order_line_pages")) {
      for (const key of [...this.lines.keys()]) {
        if (key.startsWith(`${String(values[0])}:`)) {
          this.lines.delete(key);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM ordering_order_hold_pages")) {
      for (const key of [...this.holds.keys()]) {
        if (key.startsWith(`${String(values[0])}:`)) {
          this.holds.delete(key);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO ordering_order_line_pages")) {
      this.lines.set(`${String(values[0])}:${String(values[1])}`, values);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: "ordering.order-ord_1" as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_buyer" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-09T00:00:00.000Z" as never,
      recordedAt: "2026-05-09T00:00:00.000Z" as never,
    },
  };
}

describe("ordering order projection", () => {
  it("projects accepted-offer orders into seller-visible sale rows", async () => {
    const db = new OrderProjectionDb();
    const handlers = buildOrderingOrderProjectionHandlers(db);

    await handlers["ordering.order.created"]!(
      event("ordering.order.created", {
        orderId: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        sourceType: "offer-acceptance",
        sourceReferenceId: "off_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        shippingOption: "standard",
        itemSubtotalAmount: "120.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "4.99",
        shippingAllowanceAmount: "4.99",
        shippingOverageAmount: "0.00",
        shippingChargeAmount: "0.00",
        salesTaxAmount: "0.00",
        totalAmount: "120.00",
        taxSnapshot: {
          taxableAmount: "120.00",
          salesTaxAmount: "0.00",
          jurisdictionCountry: "US",
          jurisdictionState: "IL",
          rateBps: 0,
          providerName: "local-tax-stub",
          providerQuoteReference: null,
          quotedAt: "2026-05-09T00:00:00.000Z",
        },
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: "6.00",
          sellerNetAmount: "114.00",
          sellerItemNetAmount: "114.00",
          sellerPayoutAmount: "118.99",
          shippingAllowancePercentageBps: 500,
          termsScheduleId: "terms_standard",
          termsAgreementId: null,
          termsResolvedAt: "2026-05-09T00:00:00.000Z",
        },
        shippingDestinationSnapshot: { country: "US", state: "IL", postalCode: "60601" },
        shippingOriginSnapshot: { country: "US", state: "TX", postalCode: "78701" },
        shippingPlanSnapshot: {},
        lines: [
          {
            lineId: "ord_line_1",
            listingId: "lst_1",
            inventoryItemId: "inv_1",
            catalogItemId: "cat_1",
            productId: "prd_1",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            unitPriceAmount: "120.00",
            quantity: 1,
            lineTotalAmount: "120.00",
            marketplaceSalesFeeUnitAmount: "6.00",
            marketplaceSalesFeeTotalAmount: "6.00",
            sellerNetUnitAmount: "114.00",
            sellerNetTotalAmount: "114.00",
          },
        ],
        reservationRequests: [],
      }),
    );

    expect(db.orders.get("ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toMatchObject({
      display_reference: "ORD-E6K7M8N9",
      source_type: "offer-acceptance",
      source_reference_id: "off_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      status: "pending-reservation",
    });
  });
});

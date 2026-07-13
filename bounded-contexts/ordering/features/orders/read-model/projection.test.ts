import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
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
  /** order_id -> seller_account_id, standing in for ordering_seller_open_order_claims (m127). */
  public readonly openCapacityClaims = new Map<string, string>();

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

    if (sql.includes("UPDATE ordering_order_pages")) {
      const row = this.orders.get(String(values[0]));
      if (row) {
        row.status = "cancelled";
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE ordering_seller_open_order_claims")) {
      const sellerAccountId = this.openCapacityClaims.get(String(values[0]));
      if (!sellerAccountId) {
        return { rows: [], rowCount: 0 };
      }
      this.openCapacityClaims.delete(String(values[0]));
      return { rows: [{ seller_account_id: sellerAccountId }] as Row[], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId: "ordering.order-ord_1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-05-09T00:00:00.000Z", recordedAt: "2026-05-09T00:00:00.000Z" },
  });
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

  it("releases the seller's Order Capacity claim and reports it, regardless of cancellation reason (m127)", async () => {
    const db = new OrderProjectionDb();
    db.openCapacityClaims.set("ord_1", "acc_seller");
    const onOrderCapacityReleased = vi.fn(async () => {});
    const handlers = buildOrderingOrderProjectionHandlers(db, { onOrderCapacityReleased });

    await handlers["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", {
        orderId: "ord_1",
        cancelledAt: "2026-05-09T00:10:00.000Z",
        reason: "inventory-unavailable",
      }),
    );

    expect(onOrderCapacityReleased).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      context: {
        tenantId: "tnt_1",
        audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
        trace: {},
      },
    });
    expect(db.openCapacityClaims.has("ord_1")).toBe(false);
  });

  it("does not report a capacity release when the order had no open claim", async () => {
    const db = new OrderProjectionDb();
    const onOrderCapacityReleased = vi.fn(async () => {});
    const handlers = buildOrderingOrderProjectionHandlers(db, { onOrderCapacityReleased });

    await handlers["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", {
        orderId: "ord_never_claimed",
        cancelledAt: "2026-05-09T00:10:00.000Z",
        reason: "buyer-cancelled",
      }),
    );

    expect(onOrderCapacityReleased).not.toHaveBeenCalled();
  });
});

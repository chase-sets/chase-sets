import { describe, expect, it, vi } from "vitest";
import { createOrderingUcpHandlers } from "../support/ucp-support/orders";

describe("Ordering UCP order responses", () => {
  it("uses the public request origin for purchase permalinks", async () => {
    const purchase = {
      order_id: "ord_1",
      display_reference: "CS-1",
      source_reference_id: "chk_1",
      status: "pending-payment",
      ready_for_fulfillment_at: null,
      shipping_destination_snapshot: {
        name: "Buyer",
        line1: "1 Main St",
        line2: null,
        city: "Chicago",
        state: "IL",
        country: "US",
        postalCode: "60601",
      },
      lines: [],
      item_subtotal_amount: "10.00",
      shipping_charge_amount: "0.00",
      sales_tax_amount: "0.00",
      total_amount: "10.00",
      cancelled_at: null,
      cancellation_reason: null,
    };
    const handlers = createOrderingUcpHandlers({
      orders: {
        getPurchase: vi.fn(async () => purchase),
        getSale: vi.fn(async () => null),
      },
    } as never);

    const result = await handlers.restHandlers.get_order({
      actor: { accountId: "acc_1", permissions: ["orders.view"] },
      arguments: { id: "ord_1" },
      params: {},
      request: new Request("http://internal.example/ucp/v1/orders/ord_1"),
    } as never);

    expect(result).toMatchObject({
      ucp: { status: "success" },
      permalink_url: "https://internal.example/account/purchases/ord_1",
      totals: [
        { type: "subtotal", amount: 1000 },
        { type: "fulfillment", amount: 0 },
        { type: "tax", amount: 0 },
        { type: "total", amount: 1000 },
      ],
    });
  });
});

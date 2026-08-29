import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OrderingApiEnv } from "../../../api";
import { createAccountPurchaseOrderRoutes, createAccountSaleOrderRoutes } from "./route";
import type { OrderingOrderServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: OrderingApiEnv["Variables"]["actor"];
    services: OrderingOrderServices;
  }>,
) {
  const app = new Hono<OrderingApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountPurchaseOrderRoutes(options.services));

  return app;
}

function createServices(): OrderingOrderServices {
  return {
    cancelPurchase: vi.fn(async () => ({ orderId: "ord_1", version: 3 })),
    createOrdersFromCheckout: vi.fn(async () => ({ orderIds: ["ord_checkout" as never] })),
    previewCheckoutFulfillment: vi.fn(async () => ({
      revision: "preview_1",
      optimizationGoal: "lowest-total",
      readyLineKeys: ["cart_line_1"],
      unavailableLineKeys: [],
      sellerGroups: [],
      totals: {
        itemSubtotalAmount: "0.00",
        shippingAmount: "0.00",
        salesTaxAmount: "0.00",
        totalAmount: "0.00",
        packageCount: 0,
      },
      unavailableLines: [],
      materialChangeReasons: [],
    })),
    listPurchases: vi.fn(async () => ({ items: [], total: 0 })),
    getPurchase: vi.fn(async () => null),
    listSales: vi.fn(async () => ({ items: [], total: 0 })),
    getSale: vi.fn(async () => null),
    getOrderReviewOpportunity: vi.fn(async () => null),
    cleanupAuthority: { kind: "not-mounted" },
    projectors: [],
  } as unknown as OrderingOrderServices;
}

describe("ordering purchase routes", () => {
  const order = {
    order_id: "ord_1",
    source_type: "cart-checkout",
    source_reference_id: null,
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    item_subtotal_amount: "20.00",
    shipping_base_amount: "4.99",
    shipping_discount_amount: "0.00",
    shipping_allowance_amount: "4.99",
    shipping_overage_amount: "0.00",
    shipping_charge_amount: "4.99",
    sales_tax_amount: "0.00",
    marketplace_sales_fee_amount: "1.00",
    seller_net_amount: "19.00",
    seller_item_net_amount: "19.00",
    seller_payout_amount: "23.99",
    shipping_allowance_percentage_bps: 500,
    taxable_amount: "24.99",
    tax_jurisdiction_country: "US",
    tax_jurisdiction_state: "IL",
    tax_rate_bps: 0,
    tax_provider_name: "local-tax-stub",
    tax_provider_quote_reference: null,
    tax_quoted_at: "2026-04-02T00:00:00.000Z",
    total_amount: "24.99",
    terms_schedule_id: "cts_default",
    terms_agreement_id: null,
    terms_resolved_at: "2026-04-02T00:00:00.000Z",
    shipping_destination_snapshot: {},
    shipping_origin_snapshot: {},
    status: "ready-for-fulfillment",
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    cancelled_at: null,
    cancellation_reason: null,
    ready_for_fulfillment_at: "2026-04-02T00:15:00.000Z",
    self_service_cancellation_available: false,
    cancellation_unavailable_reason: null,
    line_count: 1,
    total_quantity: 1,
    lines: [],
    inventory_holds: [],
  };

  it("adds a local Ordering review opportunity to purchase details when the actor can manage reviews", async () => {
    const services = {
      ...createServices(),
      getPurchase: vi.fn(async () => order),
      getOrderReviewOpportunity: vi.fn(async () => ({
        order_id: "ord_1",
        subject_account_id: "acc_seller",
        subject_display_name: "Seller",
        author_role: "buyer",
        eligible_at: "2026-04-02T00:00:00.000Z",
        active_review_id: null,
      })),
    } as unknown as OrderingOrderServices;
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "reputation.view", "reputation.manage"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://ordering.test/account/purchases/ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      order_id: "ord_1",
      reviewOpportunity: {
        subject_account_id: "acc_seller",
        author_role: "buyer",
      },
    });
    expect(services.getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1", "acc_buyer");
  });

  it("omits purchase review opportunities without reputation permissions", async () => {
    const services = {
      ...createServices(),
      getPurchase: vi.fn(async () => order),
      getOrderReviewOpportunity: vi.fn(async () => {
        throw new Error("should not read reputation overlay");
      }),
    } as unknown as OrderingOrderServices;
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://ordering.test/account/purchases/ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      order_id: "ord_1",
      reviewOpportunity: null,
    });
    expect(services.getOrderReviewOpportunity).not.toHaveBeenCalled();
  });

  it("cancels a buyer purchase through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/ord_1/cancel", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "ord_1",
      version: 3,
      status: "cancelled",
    });
    expect(services.cancelPurchase).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_buyer",
        }),
      }),
    );
  });

  it("cancels a seller sale through the documented API action", async () => {
    const services = {
      ...createServices(),
      cancelSale: vi.fn(async () => ({ orderId: "ord_1", version: 4 })),
    } as unknown as OrderingOrderServices;
    const app = new Hono<OrderingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      });
      c.set("context", {
        tenantId: "tnt_identity" as never,
        audit: {
          performedByUserId: "usr_seller" as never,
          forAccountId: "acc_seller" as never,
        },
      });
      await next();
    });
    app.route("/account", createAccountSaleOrderRoutes(services));

    const response = await app.fetch(
      new Request("http://ordering.test/account/sales/ord_1/cancel", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "ord_1",
      version: 4,
      status: "cancelled",
    });
    expect(services.cancelSale).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        sellerAccountId: "acc_seller",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("adds a local Ordering review opportunity to sale details when the actor can manage reviews", async () => {
    const services = {
      ...createServices(),
      getSale: vi.fn(async () => order),
      getOrderReviewOpportunity: vi.fn(async () => ({
        order_id: "ord_1",
        subject_account_id: "acc_buyer",
        subject_display_name: "Buyer",
        author_role: "seller",
        eligible_at: "2026-04-02T00:00:00.000Z",
        active_review_id: "rev_1",
      })),
    } as unknown as OrderingOrderServices;
    const app = new Hono<OrderingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "reputation.view", "reputation.manage"],
      });
      await next();
    });
    app.route("/account", createAccountSaleOrderRoutes(services));

    const response = await app.fetch(new Request("http://ordering.test/account/sales/ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      order_id: "ord_1",
      reviewOpportunity: {
        subject_account_id: "acc_buyer",
        author_role: "seller",
        active_review_id: "rev_1",
      },
    });
    expect(services.getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1", "acc_seller");
  });

  it("lets signed-in buyers without order-management permissions preview checkout fulfillment", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_buyer",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_buyer",
        roleKey: "member",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "buy-now",
          shippingOption: "standard",
          optimizationGoal: "lowest-total",
          lines: [
            {
              cartLineId: "cart_line_1",
              listingId: null,
              catalogItemId: "cat_1",
              productId: "prd_1",
              itemTitle: "Test card",
              itemSubtitle: null,
              selectedOptions: [],
              productSummary: null,
              quantity: 1,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: "preview_1",
      optimizationGoal: "lowest-total",
    });
    expect(services.previewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerAccountId: "acc_buyer",
        checkoutSessionId: "chk_1",
        sourceType: "buy-now",
      }),
    );
  });

  it("rejects pre-commitment Checkout sources at the Ordering preview boundary", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_buyer",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_buyer",
        roleKey: "member",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "offer-intent",
          shippingOption: "standard",
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Ordering checkout source must be cart-checkout or buy-now.",
      },
    });
    expect(services.previewCheckoutFulfillment).not.toHaveBeenCalled();
  });

  it("rejects unknown checkout sources at the Ordering creation boundary", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_buyer",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_buyer",
        roleKey: "member",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "cart",
          shippingOption: "standard",
          shippingAddress: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Ordering checkout source must be cart-checkout or buy-now.",
      },
    });
    expect(services.createOrdersFromCheckout).not.toHaveBeenCalled();
  });

  it("lets signed-in buyers without order-management permissions confirm checkout as account buyers", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_buyer",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_buyer",
        roleKey: "member",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "cart-checkout",
          shippingOption: "standard",
          shippingAddress: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      orderIds: ["ord_checkout"],
      status: "created",
    });
    expect(services.createOrdersFromCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerAccountId: "acc_buyer",
        customerAccountIsGuest: false,
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_buyer",
        }),
      }),
    );
  });

  it("returns checkout order commit metadata for downstream payment freshness", async () => {
    const services = {
      ...createServices(),
      createOrdersFromCheckout: vi.fn(async () => ({
        orderIds: ["ord_checkout" as never],
        commitPosition: "42",
        commitEventIds: ["evt_order_created"],
        commitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      })),
    } as unknown as OrderingOrderServices;
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_buyer",
        roleKey: "member",
        permissions: ["accounts.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "cart-checkout",
          shippingOption: "standard",
          shippingAddress: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      orderIds: ["ord_checkout"],
      status: "created",
      commitPosition: "42",
      commitEventIds: ["evt_order_created"],
      commitPositions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
  });

  it("returns sign-in-required when guest confirmation hits account-scoped limits", async () => {
    const services = {
      ...createServices(),
      createOrdersFromCheckout: vi.fn(async () => {
        throw new Error("Sign in is required to confirm checkout for listings with daily or customer purchase limits.");
      }),
    } as unknown as OrderingOrderServices;
    const app = buildApp({
      actor: {
        sessionId: "guest:tok_1",
        tenantId: "tnt_identity",
        userId: "usr_guest_checkout",
        accountId: "acc_guest",
        membershipId: "guest:tok_1",
        roleKey: "guest-buyer",
        permissions: ["guest-checkout.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "cart-checkout",
          shippingOption: "standard",
          shippingAddress: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "account_sign_in_required",
        message: "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
      },
    });
    expect(services.createOrdersFromCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerAccountIsGuest: true,
      }),
      expect.anything(),
    );
  });
});

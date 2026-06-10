import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import { createAccountSellListRoutes, createGuestSellListRoutes } from "./route";
import type { CheckoutSellListServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: CheckoutApiEnv["Variables"]["actor"];
    services: CheckoutSellListServices;
  }>,
) {
  const app = new Hono<CheckoutApiEnv>();

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

  app.route("/account", createAccountSellListRoutes(options.services));
  app.route("/guest", createGuestSellListRoutes(options.services));

  return app;
}

function createServices(): CheckoutSellListServices {
  return {
    addLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 1, status: "added" })),
    removeLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 2 })),
    checkoutSellList: vi.fn(async () => ({ sellerAccountId: "acc_seller" as never, version: 3, status: "reviewed" })),
    startSellListExecution: vi.fn(async () => ({
      seller_account_id: "acc_seller",
      execution_id: "sle_1",
      status: "pending",
      execution_plan: { version: 1, lines: [] },
      execution_progress: { completedActionKeys: [] },
      execution_summary: null,
      created_at: "2026-05-30T00:00:00.000Z",
      updated_at: "2026-05-30T00:00:00.000Z",
      finalized_at: null,
    })),
    getExecution: vi.fn(async () => ({
      seller_account_id: "acc_seller",
      execution_id: "sle_1",
      status: "pending",
      execution_plan: { version: 1, lines: [] },
      execution_progress: { completedActionKeys: [] },
      execution_summary: null,
      created_at: "2026-05-30T00:00:00.000Z",
      updated_at: "2026-05-30T00:00:00.000Z",
      finalized_at: null,
    })),
    getLatestPendingExecution: vi.fn(async () => null),
    recordSellListExecutionProgress: vi.fn(async () => ({
      seller_account_id: "acc_seller",
      execution_id: "sle_1",
      status: "pending",
      execution_plan: { version: 1, lines: [] },
      execution_progress: { completedActionKeys: ["offer:sll_1:off_1"] },
      execution_summary: null,
      created_at: "2026-05-30T00:00:00.000Z",
      updated_at: "2026-05-30T00:00:00.000Z",
      finalized_at: null,
    })),
    mergeSellListIntoAccount: vi.fn(async () => ({ mergedLineCount: 1 })),
    createReadinessSnapshot: vi.fn(async () => ({
      schemaVersion: "checkout.sell-list-readiness.v1",
      source: "sell-list",
      sourceRevision: "slr_source",
      snapshotId: "slr_ready",
      status: "ready",
      lineCount: 1,
      includedLineIds: ["sll_1"],
      unresolvedLineIds: [],
      lineOutcomes: [{ lineId: "sll_1", outcome: "checkout", reason: "ready", action: "selected-offer" }],
      sellerReadiness: {
        payout: "not-evaluated",
        shipFrom: "not-evaluated",
        label: "not-evaluated",
      },
      customerSafeFacts: ["Ready for seller checkout."],
    })),
    listLines: vi.fn(async () => []),
    getLatestReceipt: vi.fn(async () => null),
    projectors: [],
  } as unknown as CheckoutSellListServices;
}

function sellerActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_seller",
    accountId: "acc_seller",
    membershipId: "mbr_seller",
    roleKey: "owner",
    permissions: ["listings.view", "offers.view"],
  };
}

function guestCheckoutActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "guest:tok_1",
    tenantId: "tnt_identity",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  };
}

describe("checkout sell list routes", () => {
  it("counts sell list item quantities instead of raw lines", async () => {
    const services = createServices();
    vi.mocked(services.listLines).mockResolvedValue([
      { line_id: "sll_1", quantity: 2 },
      { line_id: "sll_2", quantity: 3 },
    ] as never);
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list"));

    await expect(response.json()).resolves.toMatchObject({
      count: 5,
    });
  });

  it("returns the latest pending Sell List execution so checkout can resume sale work", async () => {
    const services = createServices();
    vi.mocked(services.getLatestPendingExecution).mockResolvedValue({
      seller_account_id: "acc_seller",
      execution_id: "sle_pending",
      status: "pending",
      execution_plan: { version: 1, lines: [] },
      execution_progress: { completedActionKeys: ["selected-offer:sll_1:off_1"] },
      execution_summary: null,
      created_at: "2026-05-30T00:00:00.000Z",
      updated_at: "2026-05-30T00:01:00.000Z",
      finalized_at: null,
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(new Request("http://checkout.test/account/sell-list/executions/latest-pending"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution_id: "sle_pending",
      status: "pending",
      execution_progress: { completedActionKeys: ["selected-offer:sll_1:off_1"] },
    });
  });

  it("adds product-level seller intent to the Checkout-owned Sell List", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
          fallbackMode: "create-listing",
          minimumListingPriceAmount: "399.00",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 1,
      status: "added",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "product",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
        fallbackMode: "create-listing",
        minimumListingPriceAmount: "399.00",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("adds a selected offer line to the Checkout-owned Sell List", async () => {
    const services = createServices();
    vi.mocked(services.addLine).mockResolvedValue({
      lineId: "sll_offer" as never,
      version: 4,
      status: "merged",
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_charizard",
          buyerAccountId: "acc_buyer",
          buyerDisplayName: "Ash Ketchum",
          offerPriceAmount: "350.00",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_offer",
      version: 4,
      status: "merged",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "selected-offer",
        offerId: "off_charizard",
        buyerAccountId: "acc_buyer",
        buyerDisplayName: "Ash Ketchum",
        offerPriceAmount: "350.00",
      }),
      expect.any(Object),
    );
  });

  it("creates a signed-in Sell List readiness snapshot with pre-checkout sale action decisions", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineActions: [{ lineId: "sll_1", action: "smart-match" }],
          lineOutcomes: [{ lineId: "sll_2", outcome: "keep-in-list" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { snapshotId: "slr_ready", status: "ready" },
    });
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      decisions: {
        lineActions: [{ lineId: "sll_1", action: "smart-match" }],
        lineOutcomes: [{ lineId: "sll_2", outcome: "keep-in-list" }],
      },
    });
  });

  it("removes a Sell List line", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/sll_1/remove", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 2,
      status: "removed",
    });
    expect(services.removeLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineId: "sll_1",
      }),
      expect.any(Object),
    );
  });

  it("records Sell List checkout review for a seller account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: "sle_1",
          readinessSnapshotId: "slr_ready",
          readinessSourceRevision: "slr_source",
          readinessDecisions: {
            lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "acc_seller",
      version: 3,
      status: "reviewed",
    });
    expect(services.checkoutSellList).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        executionId: "sle_1",
        readinessSnapshotId: "slr_ready",
        readinessSourceRevision: "slr_source",
        readinessDecisions: {
          lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
          lineOutcomes: [],
        },
      }),
      expect.any(Object),
    );
  });

  it("rejects Sell List checkout review without readiness evidence", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionId: "sle_1" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "Sell List readiness snapshot is required.",
      },
    });
    expect(services.checkoutSellList).not.toHaveBeenCalled();
  });

  it("starts a durable Sell List execution before sale side effects", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionId: "sle_1", executionPlan: { version: 1, lines: [] } }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "acc_seller",
      executionId: "sle_1",
      status: "pending",
      executionPlan: { version: 1, lines: [] },
    });
    expect(services.startSellListExecution).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      executionId: "sle_1",
      executionPlan: { version: 1, lines: [] },
    });
  });

  it("records Sell List execution progress by action key", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/executions/sle_1/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedActionKey: "offer:sll_1:off_1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "acc_seller",
      executionId: "sle_1",
      executionProgress: { completedActionKeys: ["offer:sll_1:off_1"] },
    });
    expect(services.recordSellListExecutionProgress).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      executionId: "sle_1",
      completedActionKey: "offer:sll_1:off_1",
    });
  });

  it("blocks guest checkout actors from seller Sell List review", async () => {
    const services = createServices();
    const app = buildApp({ actor: guestCheckoutActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "authorization_forbidden",
        message: "Sell List review requires a seller account.",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });

  it("adds signed-out seller intent to an anonymous Sell List owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "anon_sell_1",
        lineType: "product",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_anonymous_sell_list",
          performedByUserId: "usr_anonymous_sell_list",
        }),
      }),
    );
  });

  it("adds signed-out selected offer intent to an anonymous Sell List owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_1",
          buyerAccountId: null,
          buyerDisplayName: "Collector123",
          offerPriceAmount: "40.00",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "anon_sell_1",
        lineType: "selected-offer",
        offerId: "off_1",
        buyerAccountId: null,
        buyerDisplayName: "Collector123",
      }),
      expect.anything(),
    );
  });

  it("blocks new anonymous Sell List lines after the guest line limit", async () => {
    const services = createServices();
    vi.mocked(services.listLines).mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        line_id: `sll_${index}`,
        line_type: "selected-offer",
        offer_id: `off_${index}`,
      })) as never,
    );
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_new",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_sell_list_limit_exceeded",
        message: "This device has 50 Sell List lines saved. Remove an item before adding another.",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });

  it("creates a guest Sell List readiness snapshot from the anonymous owner", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
        body: JSON.stringify({
          lineOutcomes: [{ lineId: "sll_waiting", outcome: "keep-in-list" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.createReadinessSnapshot).toHaveBeenCalledWith({
      sellerAccountId: "anon_sell_1",
      decisions: {
        lineActions: [],
        lineOutcomes: [{ lineId: "sll_waiting", outcome: "keep-in-list" }],
      },
    });
  });

  it("merges anonymous Sell List lines into a signed-in account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/guest/sell-list/merge-to-account", {
        method: "POST",
        headers: {
          "x-checkout-anonymous-sell-list-id": "anon_sell_1",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mergedLineCount: 1 });
    expect(services.mergeSellListIntoAccount).toHaveBeenCalledWith(
      {
        sourceOwnerId: "anon_sell_1",
        targetAccountId: "acc_seller",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
        }),
      }),
    );
  });
});
